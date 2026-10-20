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
import { PLUGIN_ID } from './ids.js'
import { livePhaseForSpeech, liveWorkRoute, openTurnNumber } from './work.js'
import type { LiveProxy } from './proxy.js'
import { type LiveUiEvent } from './events.js'
import {
  buildSessionContextAppend,
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
import { LIVE_INSTRUCTIONS } from './prompts.js'
import { LiveSideband } from './sideband.js'
import { signalLiveCall } from './signaling.js'
import { hasToolCalls, textFromBlocks } from './text.js'
import { resolveLiveVoice } from './voices.js'
import { LiveTaskReceiptLog, type LiveTaskReceipt } from './receipts.js'
import { buildReadoutMessages } from './readout.js'

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
      instructions: LIVE_INSTRUCTIONS,
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
  private readonly receiptLog = new LiveTaskReceiptLog()
  private readonly seenUserTurnIds = new Set<string>()
  private userSpeechOpen = false
  private userSpeechGeneration = 0
  private lastUnkeyedInput: { generation: number; text: string } | undefined
  private playbackEnabled = false
  private assistantSpeaking = false
  private readoutInFlight = false
  private readonly readoutQueue: string[] = []
  private readonly seenAssistantTurnIds = new Set<string>()
  private lastUnkeyedAssistantFinal: string | undefined
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
        const receipt = this.receiptLog.discarded(String(message.id))
        this.emitReceipt(receipt)
        if (receipt) this.sendContext('The request was discarded.')
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
    listener({ type: 'playback', enabled: this.playbackEnabled })
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
    this.readoutQueue.length = 0
    this.readoutInFlight = false
    this.setPlayback(false)
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
        if (event.item.text.trim()) this.noteUserSpeech()
        this.applyTranscript(event)
        break
      case 'output_transcript.added':
        this.mark('first-tts')
        if (event.item.text.trim()) this.noteAssistantSpeech()
        this.applyTranscript(event)
        break
      case 'turn.created':
        if (event.turn.role === 'user') this.noteUserSpeech()
        else if (event.turn.id === undefined || !this.seenAssistantTurnIds.has(event.turn.id)) this.noteAssistantSpeech()
        this.applyTranscript(event)
        break
      case 'turn.delta':
        this.applyTranscript(event)
        break
      case 'turn.done':
        this.applyTranscript(event)
        if (event.turn.role === 'user') this.handleUserTurn(event.turn)
        else this.finishAssistantTurn(event.turn)
        break
      case 'delegation.created':
        // Requests are dispatched from final ASR, never from the voice model's
        // interpretation. A generated delegation must not execute them twice.
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

  private noteUserSpeech(): void {
    this.setPlayback(false)
    if (this.userSpeechOpen) return
    this.userSpeechOpen = true
    this.userSpeechGeneration += 1
  }

  private handleUserTurn(turn: Extract<LiveServerEvent, { type: 'turn.done' }>['turn']): void {
    const input = turn.transcript
    if (!input.trim()) return
    if (turn.id !== undefined) {
      if (this.seenUserTurnIds.has(turn.id)) return
      this.seenUserTurnIds.add(turn.id)
    } else if (this.lastUnkeyedInput?.generation === this.userSpeechGeneration
      && this.lastUnkeyedInput.text === input) {
      // Without an upstream ID, an identical final without fresh speech is a
      // replay. New speech activity allows the same words to be spoken again.
      return
    }
    this.setPlayback(false)
    this.userSpeechOpen = false
    this.lastUnkeyedInput = { generation: this.userSpeechGeneration, text: input }
    const liveId = turn.id ?? `asr-${crypto.randomUUID()}`
    this.mark('asr-dispatch')
    const message = createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: PLUGIN_ID },
    })
    const route = liveWorkRoute(this.agent.status) === 'steer'
      && openTurnNumber(this.agent.session.snapshotEvents()) !== undefined
      ? 'steer'
      : 'followup'
    const receipt = this.receiptLog.create({
      id: liveId,
      messageId: String(message.id),
      taskInput: input,
      handoff: input,
      context: [],
      requestKind: this.delegations.active ? 'additional' : 'new',
      route,
    })
    this.delegations.create(liveId, message.id)
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
        if (this.delegations.commentaryAudience(event.data.turn).length) this.sendContext(text, 'commentary')
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
      const notices = new Set<string>()
      for (const result of results) {
        const receipt = receipts.find(receipt => receipt.id === result.liveId)
        const notice = receipt && terminalNotice(receipt)
        let text = result.speechText
        if (notice && !notices.has(notice)) {
          notices.add(notice)
          text = [notice, text].filter(Boolean).join('\n\n')
        }
        this.sendContext(text)
      }
      if (results.length && !this.delegations.active) this.emitPhase('listening')
    }
  }

  private sendContext(text: string, channel: LiveContextChannel = 'speakable'): void {
    if (!text.trim()) return
    if (channel === 'speakable') {
      this.readoutQueue.push(text)
      this.flushReadout()
      return
    }
    for (const chunk of chunkLiveContext(text)) {
      this.queueSend(buildSessionContextAppend(chunk, channel))
    }
  }

  private setPlayback(enabled: boolean): void {
    if (this.playbackEnabled === enabled) return
    this.playbackEnabled = enabled
    this.emit({ type: 'playback', enabled })
  }

  private noteAssistantSpeech(): void {
    this.assistantSpeaking = true
    this.lastUnkeyedAssistantFinal = undefined
  }

  private finishAssistantTurn(turn: Extract<LiveServerEvent, { type: 'turn.done' }>['turn']): void {
    if (turn.id !== undefined) {
      if (this.seenAssistantTurnIds.has(turn.id)) return
      this.seenAssistantTurnIds.add(turn.id)
    } else if (this.lastUnkeyedAssistantFinal === turn.transcript) {
      return
    }
    this.lastUnkeyedAssistantFinal = turn.transcript
    this.assistantSpeaking = false
    this.readoutInFlight = false
    // Audio can trail turn.done. Keep playback enabled until the user speaks,
    // and start the next script only after this real assistant turn finishes.
    this.flushReadout()
  }

  private flushReadout(): void {
    if (this.closed || this.closing || this.assistantSpeaking || this.readoutInFlight) return
    const text = this.readoutQueue.shift()
    if (text === undefined) return
    this.readoutInFlight = true
    this.setPlayback(true)
    for (const message of buildReadoutMessages(text, crypto.randomUUID())) this.queueSend(message)
  }

  private applyTranscript(event: LiveServerEvent): void {
    const result = ingestLiveEvent(this.transcripts, event)
    if (result === null) return
    const updates = Array.isArray(result) ? result : [result]
    for (const update of updates) {
      this.transcripts = update.state
      if (update.emit === undefined) continue
      // Keep internal timing/transcript state for muted autonomous replies,
      // but never present them as speech the user heard.
      if (update.emit.role === 'assistant' && !this.playbackEnabled) continue
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
    if (!sideband || this.closed || this.closing) return
    this.sendChain = this.sendChain
      .then(async () => {
        if (!this.closed && !this.closing) await sideband.send(message)
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

/** Short spoken outcomes; detailed task state stays in the live dock. */
function terminalNotice(receipt: LiveTaskReceipt): string | undefined {
  switch (receipt.status) {
    case 'no-reply': return 'The backend returned no text.'
    case 'cancelled': return 'The request was cancelled.'
    case 'blocked': return 'The request was blocked.'
    case 'interrupted': return 'The response was interrupted.'
    case 'max-tokens': return 'The response reached its token limit.'
    case 'failed': return receipt.error ? `The request failed: ${receipt.error}` : 'The request failed.'
    default: return undefined
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
