import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'dsh-livevoice': {
      kind: 'dsh-livevoice'
    }
  }
}
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CodexAccess } from './auth.js'
import { presentFinalTranscript } from './conversation.js'
import { LiveDelegations } from './live-delegations.js'
import { briefLiveDelegation, renderWorkerHandoff, type TranscriptLine } from './handoff.js'
import { PLUGIN_ID } from './ids.js'
import { livePhaseForSpeech, liveWorkRoute, openTurnNumber } from './work.js'
import type { LiveProxy } from './proxy.js'
import { type LiveUiEvent } from './events.js'
import {
  buildDelegationContextAppend,
  chunkLiveContext,
  type LiveClientMessage,
  type LiveContextChannel,
  type LivePhase,
  type LiveServerEvent,
  type LiveUsageMetric,
  type LiveUsageSource,
} from './protocol.js'
import {
  emptyTranscriptState,
  ingestLiveEvent,
  type LiveTranscript,
  type TranscriptState,
} from './transcript.js'

export type { LiveTranscript }
import { renderAgentFinalMessage, renderLiveInstructions } from './prompts.js'
import { LiveSideband } from './sideband.js'
import { signalLiveCall } from './signaling.js'
import { hasToolCalls, textFromBlocks } from './text.js'
import { resolveLiveVoice } from './voices.js'
import { LiveTaskReceiptLog, type LiveTaskReceipt } from './receipts.js'

export type { LiveUiEvent }

export interface LiveCallHandle {
  readonly callToken: string
  readonly callId: string
  readonly answer: string
  readonly voice: string
  readonly sessionId: string
  subscribe(listener: (event: LiveUiEvent) => void): () => void
  close(): Promise<void>
}

export class LiveCallRegistry {
  private readonly calls = new Map<string, LiveCallSession>()
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly resolveAgent: (sessionId: string) => Agent | undefined,
    private readonly resolveAccess: () => Promise<CodexAccess>,
    private readonly proxy: LiveProxy,
  ) {}

  start(input: {
    sessionId: string
    offer: string
    voice?: string
  }): Promise<LiveCallHandle> {
    return this.enqueue(() => this.startExclusive(input))
  }

  private async startExclusive(input: {
    sessionId: string
    offer: string
    voice?: string
  }): Promise<LiveCallHandle> {
    const agent = this.resolveAgent(input.sessionId)
    if (agent === undefined) {
      throw new Error(`Session ${input.sessionId} is not active.`)
    }
    await this.closeCurrentCalls()
    const voice = resolveLiveVoice(input.voice)
    const access = await this.resolveAccess()
    const realtimeSessionId = crypto.randomUUID()
    const abort = new AbortController()
    const signaling = await signalLiveCall({
      access,
      sessionId: input.sessionId,
      realtimeSessionId,
      offer: input.offer,
      instructions: renderLiveInstructions(),
      voice,
      proxy: this.proxy,
      signal: abort.signal,
    })
    const callToken = crypto.randomUUID()
    const session = new LiveCallSession({
      callToken,
      callId: signaling.callId,
      answer: signaling.answer,
      voice,
      sessionId: input.sessionId,
      agent,
      access,
      realtimeSessionId,
      proxy: this.proxy,
      abort,
    })
    this.calls.set(callToken, session)
    try {
      await session.connect()
    } catch (error) {
      this.calls.delete(callToken)
      await session.close()
      throw error
    }
    return {
      callToken,
      callId: signaling.callId,
      answer: signaling.answer,
      voice,
      sessionId: input.sessionId,
      subscribe: listener => session.subscribe(listener),
      close: async () => {
        this.calls.delete(callToken)
        await session.close()
      },
    }
  }

  get(callToken: string): LiveCallHandle | undefined {
    const session = this.calls.get(callToken)
    if (session === undefined) return undefined
    return {
      callToken: session.callToken,
      callId: session.callId,
      answer: session.answer,
      voice: session.voice,
      sessionId: session.sessionId,
      subscribe: listener => session.subscribe(listener),
      close: async () => {
        this.calls.delete(callToken)
        await session.close()
      },
    }
  }

  async closeAll(): Promise<void> {
    await this.enqueue(() => this.closeCurrentCalls())
  }

  private async closeCurrentCalls(): Promise<void> {
    const sessions = [...this.calls.values()]
    this.calls.clear()
    await Promise.all(sessions.map(session => session.close()))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    // The public caller still receives the original rejection, while the tail
    // always recovers so one failed dial cannot poison later starts/shutdown.
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

class LiveCallSession {
  readonly callToken: string
  readonly callId: string
  readonly answer: string
  readonly voice: string
  readonly sessionId: string

  private readonly agent: Agent
  private readonly abort: AbortController
  private readonly listeners = new Set<(event: LiveUiEvent) => void>()
  private readonly offAgent: () => void
  private sideband: LiveSideband | undefined
  private sendChain: Promise<void> = Promise.resolve()
  private closed = false
  private closing = false
  private ready = false
  private phase: LivePhase = 'connecting'
  private readonly delegations = new LiveDelegations()
  private transcripts: TranscriptState = emptyTranscriptState()
  private readonly unknownEventTypes = new Set<string>()
  private lastTranscript: LiveTranscript | undefined
  private lastUsage: { source: LiveUsageSource; metrics: readonly LiveUsageMetric[] } | undefined
  private spoken: TranscriptLine[] = []
  private readonly receiptLog = new LiveTaskReceiptLog()
  private readonly seenDelegationIds = new Set<string>()
  private readonly t0 = Date.now()
  private readonly marks = new Set<string>()

  constructor(options: {
    callToken: string
    callId: string
    answer: string
    voice: string
    sessionId: string
    agent: Agent
    access: CodexAccess
    realtimeSessionId: string
    proxy: LiveProxy
    abort: AbortController
  }) {
    this.callToken = options.callToken
    this.callId = options.callId
    this.answer = options.answer
    this.voice = options.voice
    this.sessionId = options.sessionId
    this.agent = options.agent
    this.abort = options.abort
    this.sideband = new LiveSideband(
      options.access,
      options.sessionId,
      options.realtimeSessionId,
      options.proxy,
      {
        onEvent: event => this.handleLiveEvent(event),
        onClose: reason => this.fail(reason),
      },
      options.abort.signal,
    )
    const offs = [
      this.agent.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (session.id !== this.agent.session.id) return
        this.handleSessionEvent(event)
      }),
      this.agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
        if (this.closed || this.closing) return
        this.delegations.claim(message.id, turn)
        this.emitReceipt(this.receiptLog.claimed(String(message.id), turn))
      }),
      this.agent.ctx.on('agent/inbox/discarded', ({ message }) => {
        if (this.closed || this.closing) return
        this.delegations.discard(message.id)
        this.emitReceipt(this.receiptLog.discarded(String(message.id)))
        if (!this.delegations.active && this.phase === 'working') this.emitPhase('listening')
      }),
    ]
    this.offAgent = () => {
      for (const off of offs) off()
    }
  }

  async connect(): Promise<void> {
    if (!this.sideband) throw new Error('Live sideband is missing')
    await this.sideband.connect(this.callId)
    // session.started rides the client's oai-events channel after this answer
    // is applied. Waiting for it here deadlocks signaling against ICE.
    this.mark('sideband')
  }

  subscribe(listener: (event: LiveUiEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.ready) listener({ type: 'ready' })
    listener({ type: 'phase', phase: this.phase })
    if (this.lastTranscript) listener({ type: 'transcript', transcript: this.lastTranscript })
    if (this.lastUsage) listener({ type: 'usage', source: this.lastUsage.source, metrics: this.lastUsage.metrics })
    for (const receipt of this.receiptLog.snapshot()) {
      listener({ type: 'task-receipt', receipt })
    }
    return () => { this.listeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return
    this.closing = true
    for (const receipt of this.receiptLog.stopTracking()) this.emitReceipt(receipt)
    this.offAgent()
    await this.sendChain
    this.closed = true
    this.abort.abort()
    const sideband = this.sideband
    this.sideband = undefined
    await sideband?.close()
    this.emit({ type: 'closed' })
    this.listeners.clear()
  }

  private handleLiveEvent(event: LiveServerEvent): void {
    if (this.closed || this.closing) return
    switch (event.type) {
      case 'session.started':
      case 'session.updated':
        this.mark(event.type)
        this.markReady()
        break
      case 'input_transcript.added':
        this.mark('first-asr')
        this.applyTranscript(event)
        break
      case 'output_transcript.added':
        this.mark('first-tts')
        this.applyTranscript(event)
        break
      case 'turn.created':
      case 'turn.delta':
      case 'turn.done':
        this.applyTranscript(event)
        break
      case 'delegation.created':
        this.mark('delegation')
        this.handleDelegation(event)
        break
      case 'session.usage.updated':
      case 'rate_limits.updated':
        this.lastUsage = { source: event.type, metrics: event.metrics }
        this.emit({ type: 'usage', source: event.type, metrics: event.metrics })
        break
      case 'output_audio.delta':
        break
      case 'error':
        this.fail(event.message)
        break
      case 'unknown':
        // Codex mirrors per-frame audio (session.input_audio.append,
        // session.output_audio.delta) and delegation.context.appended acks on
        // the sideband; log each new type once per call, not every frame.
        if (!this.unknownEventTypes.has(event.wireType)) {
          this.unknownEventTypes.add(event.wireType)
          console.log(`[dsh-livevoice] unknown live event ${event.wireType} (further ones of this type are not logged)`)
        }
        break
      default: {
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  }

  private handleDelegation(event: Extract<LiveServerEvent, { type: 'delegation.created' }>): void {
    if (this.seenDelegationIds.has(event.item.id)) return
    this.seenDelegationIds.add(event.item.id)
    let request = ''
    for (const content of event.item.content) {
      if (content.type !== 'input_text') continue
      request += `${request ? '\n' : ''}${content.text}`
    }
    const input = briefLiveDelegation({ liveText: request })
    if (input === undefined) return
    const context = recentTranscript(this.spoken, this.transcripts.user.text)
    const handoff = renderWorkerHandoff({
      input,
      transcriptDelta: context,
    })
    if (handoff === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: handoff }],
      source: { kind: PLUGIN_ID },
    })
    const route = liveWorkRoute(this.agent.status) === 'steer'
      && openTurnNumber(this.agent.session.snapshotEvents()) !== undefined
      ? 'steer'
      : 'followup'
    const receipt = this.receiptLog.create({
      id: event.item.id,
      messageId: String(message.id),
      taskInput: input,
      handoff,
      context,
      requestKind: this.delegations.active ? 'additional' : 'new',
      route,
    })
    this.delegations.create(event.item.id, message.id)
    this.emitReceipt(receipt)
    try {
      if (route === 'steer') this.agent.steer(message)
      else this.agent.followup(message)
      if (this.delegations.active) this.emitPhase('working')
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      this.delegations.discard(message.id)
      this.emitReceipt(this.receiptLog.failed(receipt.id, messageText))
      this.fail(messageText)
    }
  }

  private handleSessionEvent(event: SessionEvent): void {
    if (this.closed || this.closing || !this.delegations.active) return
    if (event.type === 'assistant/message') {
      const text = textFromBlocks(event.data.message.content)
      if (hasToolCalls(event.data.message.content)) {
        this.fanout(this.delegations.commentaryAudience(event.data.turn), text, 'commentary')
      } else {
        this.delegations.reply(event.data.turn, event.seq, text)
      }
      return
    }
    if (event.type === 'turn/end') {
      const results = this.delegations.end(event.data.turn)
      const receipts = results.flatMap(result => this.receiptLog.ended({
        id: result.liveId,
        turn: event.data.turn,
        ...taskReceiptOutcome(event.data.reason, result.text),
      }))
      for (const receipt of receipts) this.emitReceipt(receipt)
      for (const result of results) {
        if (result.text) {
          const text = event.data.reason.kind === 'completed'
            ? renderAgentFinalMessage(result.text)
            : `Partial worker response; turn ended ${event.data.reason.kind}, not successfully completed.\n\n${result.text}`
          this.fanout([result.liveId], text)
        }
      }
      if (results.length && !this.delegations.active) this.emitPhase('listening')
    }
  }

  private fanout(liveIds: readonly string[], text: string, channel: LiveContextChannel = 'speakable'): void {
    const trimmed = text.trim()
    if (!trimmed || liveIds.length === 0) return
    for (const liveId of liveIds) {
      for (const chunk of chunkLiveContext(trimmed)) {
        this.queueSend(buildDelegationContextAppend(liveId, chunk, channel))
      }
    }
  }

  private applyTranscript(event: LiveServerEvent): void {
    const result = ingestLiveEvent(this.transcripts, event)
    if (result === null) return
    const updates = Array.isArray(result) ? result : [result]
    for (const update of updates) {
      this.transcripts = update.state
      const duplicate = this.lastTranscript?.role === update.emit.role
        && this.lastTranscript.turn === update.emit.turn
        && this.lastTranscript.text === update.emit.text
        && this.lastTranscript.final === update.emit.final
      if (!duplicate) {
        this.lastTranscript = update.emit
        this.emit({ type: 'transcript', transcript: update.emit })
        const phase = livePhaseForSpeech({
          backendWorking: this.delegations.active,
          role: update.emit.role,
          final: update.emit.final,
        })
        if (phase !== undefined) this.emitPhase(phase)
      }
      if (!update.present) continue
      this.spoken.push({ role: update.present.role, text: update.present.text })
      try {
        presentFinalTranscript(this.agent.session, {
          role: update.present.role,
          text: update.present.text,
          backendWorking: this.delegations.active,
        })
      } catch {
        // Conversation present must not take down the live call.
      }
    }
  }

  private queueSend(message: LiveClientMessage): void {
    const sideband = this.sideband
    if (!sideband || this.closed) return
    this.sendChain = this.sendChain
      .then(async () => {
        if (!this.closed) await sideband.send(message)
      })
      .catch(error => this.fail(error instanceof Error ? error.message : String(error)))
  }

  private emitPhase(phase: LivePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.emit({ type: 'phase', phase })
  }

  private emitReceipt(receipt: LiveTaskReceipt | undefined): void {
    if (!receipt) return
    this.emit({ type: 'task-receipt', receipt })
    const active = this.receiptLog.snapshot().filter(item => item.status === 'queued' || item.status === 'running')
    const status = `Worker task status: ${JSON.stringify({
      id: receipt.id, status: receipt.status,
      active: active.map(item => ({ id: item.id, status: item.status })),
      ...receipt.error ? { error: receipt.error } : {},
    })}. ${receipt.status === 'tracking-stopped'
      ? 'Call tracking stopped; DSH work may continue. Follow the DSH session; do not claim it was cancelled or completed.'
      : active.length === 0
        ? 'No tracked worker requests remain active. Do not promise a later result or say work is still running.'
        : 'Only the listed active requests are still pending; do not describe a settled request as running.'}`
    this.fanout([receipt.id], status,
      receipt.status === 'queued' || receipt.status === 'running' || receipt.status === 'replied' ? 'commentary' : undefined)
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.emit({ type: 'ready' })
    if (this.phase === 'connecting') this.emitPhase('listening')
  }

  private fail(message: string): void {
    if (this.closed || this.closing) return
    this.phase = 'error'
    for (const receipt of this.receiptLog.stopTracking()) this.emitReceipt(receipt)
    this.emit({ type: 'error', message })
    void this.close()
  }

  private emit(event: LiveUiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // UI listeners must not take down the live call.
      }
    }
  }

  private mark(label: string): void {
    if (this.marks.has(label)) return
    this.marks.add(label)
    console.log(`[dsh-livevoice] +${Date.now() - this.t0}ms ${label}`)
  }
}

function taskReceiptOutcome(
  reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason'],
  finalText: string,
): {
  status: Extract<LiveTaskReceipt['status'], 'replied' | 'no-reply' | 'cancelled' | 'blocked' | 'interrupted' | 'max-tokens' | 'failed'>
  error?: string
} {
  switch (reason.kind) {
    case 'completed':
      return { status: finalText.length > 0 ? 'replied' : 'no-reply' }
    case 'aborted':
      return { status: 'cancelled' }
    case 'blocked':
      return { status: 'blocked' }
    case 'interrupted':
      return { status: 'interrupted' }
    case 'max-tokens':
      return { status: 'max-tokens' }
    case 'error':
      return { status: 'failed', error: reason.error.message }
    default:
      return { status: 'interrupted' }
  }
}

function recentTranscript(lines: readonly TranscriptLine[], currentUserText = ''): TranscriptLine[] {
  const current = currentUserText.trim()
  const lastUser = [...lines].reverse().find(line => line.role === 'user')?.text.trim()
  const source = current && current !== lastUser
    ? [...lines, { role: 'user' as const, text: current }]
    : [...lines]
  const selected: TranscriptLine[] = []
  let remaining = 6_000
  for (const line of source.slice(-12).reverse()) {
    if (remaining <= 0) break
    const text = line.text.length <= remaining
      ? line.text
      : remaining === 1
        ? '…'
        : `…${line.text.slice(-(remaining - 1))}`
    selected.push({ role: line.role, text })
    remaining -= text.length
  }
  return selected.reverse()
}
