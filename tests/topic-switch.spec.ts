import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { createAssistantMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm"
import type { SessionEvent } from "@deepseek-ai/dsh-session"
import type { CodexAccess } from "../src/auth.ts"
import type { LiveProxy } from "../src/proxy.ts"
import type { LiveClientMessage, LiveServerEvent } from "../src/protocol.ts"
import { LiveCallRegistry, type LiveUiEvent } from "../src/controller.ts"

const wire = vi.hoisted(() => ({
  liveEvent: undefined as undefined | ((event: LiveServerEvent) => void),
  sentMessages: [] as LiveClientMessage[],
}))

vi.mock("../src/signaling.js", () => ({
  signalLiveCall: async () => ({ callId: "fixture-call", answer: "fixture-answer" }),
}))
vi.mock("../src/sideband.js", () => ({
  LiveSideband: class {
    constructor(_access: unknown, _session: unknown, _realtime: unknown, _proxy: unknown,
      handlers: { onEvent(event: LiveServerEvent): void }) { wire.liveEvent = handlers.onEvent }
    async connect() {}
    async close() {}
    async send(message: LiveClientMessage) {
      wire.sentMessages.push(message)
    }
  },
}))

type Handler = (...args: any[]) => void

function fixtureAgent() {
  const handlers = new Map<string, Handler[]>()
  const events: SessionEvent[] = []
  const followup = vi.fn()
  const steer = vi.fn()
  const session = {
    id: "fixture-session",
    snapshotEvents: () => events,
    append: vi.fn(),
  }
  const agent = {
    status: "idle",
    followup,
    steer,
    session,
    ctx: {
      on: (name: string, handler: Handler) => {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => {}
      },
    },
  } as unknown as Agent
  return {
    agent,
    session,
    events,
    followup,
    steer,
    emit(name: string, ...args: unknown[]) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
    pushAndEmit(event: SessionEvent) {
      events.push(event)
      for (const handler of handlers.get("session/event") ?? []) handler(session, event)
    },
  }
}

function userTurn(id: string | undefined, text: string): LiveServerEvent {
  return { type: 'turn.done', turn: { role: 'user', transcript: text, ...(id ? { id } : {}) } }
}

function modelDelegation(id: string, text: string): LiveServerEvent {
  return {
    type: 'delegation.created',
    item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text }] },
  }
}

function assistantEvent(turn: number, step: number, text: string): SessionEvent {
  return {
    type: "assistant/message",
    seq: turn * 100 + step,
    time: turn * 100 + step,
    data: {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: "text", text }],
        source: { provider: "mock", model: "mock" },
      }),
    },
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10))

type EndReason = Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']

async function scenario(run: (fixture: ReturnType<typeof fixtureAgent>, events: LiveUiEvent[], close: () => Promise<void>, subscribe: (listener: (event: LiveUiEvent) => void) => () => void) => Promise<void>) {
  const fixture = fixtureAgent()
  const registry = new LiveCallRegistry(() => fixture.agent, async () => ({} as CodexAccess), {} as LiveProxy)
  const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
  const events: LiveUiEvent[] = []
  call.subscribe(event => events.push(event))
  try { await run(fixture, events, () => call.close(), listener => call.subscribe(listener)) } finally { await call.close() }
}

function end(fixture: ReturnType<typeof fixtureAgent>, turn: number, reason: EndReason = { kind: 'completed' }) {
  fixture.pushAndEmit({ type: 'turn/end', seq: turn * 100 + 99, time: 1, data: { turn, reason } })
}

function speakableCues() {
  return wire.sentMessages.filter(message => message.type === 'session.context.append'
    && message.channel === 'speakable')
    .flatMap(message => 'content' in message ? message.content.map(block => block.text) : [])
}

function rawPayload() {
  return wire.sentMessages.flatMap(message => 'content' in message
    ? message.content.map(block => block.text) : []).join('')
}

function speech() {
  const staged = wire.sentMessages.filter(message => message.type === 'session.context.append'
    && message.channel === 'commentary')
    .flatMap(message => 'content' in message ? message.content.map(block => block.text) : []).join('')
  return [...staged.matchAll(/<read_aloud id="[^"]+">\n([\s\S]*?)\n<\/read_aloud>/g)].map(match => match[1])
}

function payload(commentary = false) {
  return commentary ? rawPayload() : speech().join('')
}

let assistantTurnNumber = 0
async function finishSpeech() {
  wire.liveEvent?.({
    type: 'turn.done',
    turn: { id: 'spoken-' + ++assistantTurnNumber, role: 'assistant', transcript: 'readout finished' },
  })
  await flush()
}

function latest(events: LiveUiEvent[], id: string) {
  return events.filter(event => event.type === 'task-receipt' && event.receipt.id === id).at(-1)
}

beforeEach(() => {
  wire.liveEvent = undefined
  wire.sentMessages = []
  assistantTurnNumber = 0
})

describe('LiveVoice direct ASR and backend readout', () => {
  it('mutes autonomous replies and waits for their actual final before enabling backend readout', async () => {
    await scenario(async (fixture, events, _close, subscribe) => {
      expect(events).toContainEqual({ type: 'playback', enabled: false })
      wire.liveEvent?.({ type: 'input_transcript.added', item: { text: 'A かな' } })
      wire.liveEvent?.(userTurn('A', 'A かな'))
      const userPresentCalls = fixture.session.append.mock.calls.length
      expect(userPresentCalls).toBeGreaterThan(0)
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      wire.liveEvent?.({ type: 'turn.created', turn: { id: 'local-reply', role: 'assistant', transcript: '' } })
      wire.liveEvent?.({ type: 'output_transcript.added', item: { text: '独自の回答' } })
      fixture.pushAndEmit(assistantEvent(1, 1, 'バックエンドの回答です。'))
      end(fixture, 1)
      await flush()
      expect(wire.sentMessages).toEqual([])
      expect(events.filter(event => event.type === 'playback')).toEqual([{ type: 'playback', enabled: false }])
      expect(events.some(event => event.type === 'transcript' && event.transcript?.role === 'assistant')).toBe(false)
      expect(fixture.session.append).toHaveBeenCalledTimes(userPresentCalls)

      wire.liveEvent?.({ type: 'turn.done', turn: { id: 'local-reply', role: 'assistant', transcript: '独自の回答です。' } })
      await flush()
      expect(speech()).toEqual(['バックエンドの回答です。'])
      expect(events.filter(event => event.type === 'playback').at(-1)).toEqual({ type: 'playback', enabled: true })
      expect(fixture.session.append).toHaveBeenCalledTimes(userPresentCalls)
      const replay: LiveUiEvent[] = []
      subscribe(event => replay.push(event))()
      expect(replay).toContainEqual({ type: 'playback', enabled: true })
      expect(replay.some(event => event.type === 'transcript' && event.transcript?.role === 'assistant')).toBe(false)

      wire.liveEvent?.({ type: 'output_transcript.added', item: { text: 'バックエンドの回答です。' } })
      wire.liveEvent?.({ type: 'turn.done', turn: { id: 'readout-A', role: 'assistant', transcript: 'バックエンドの回答です。' } })
      expect(events).toContainEqual({ type: 'playback', enabled: true })
      expect(events.filter(event => event.type === 'playback').at(-1)).toEqual({ type: 'playback', enabled: true })
      expect(events.some(event => event.type === 'transcript' && event.transcript?.text === 'バックエンドの回答です。')).toBe(true)
      expect(fixture.session.append.mock.calls.length).toBeGreaterThan(userPresentCalls)

      wire.liveEvent?.({ type: 'input_transcript.added', item: { text: '次は B' } })
      expect(events.filter(event => event.type === 'playback').at(-1)).toEqual({ type: 'playback', enabled: false })
      const mutedReplay: LiveUiEvent[] = []
      subscribe(event => mutedReplay.push(event))()
      expect(mutedReplay).toContainEqual({ type: 'playback', enabled: false })
    })
  })

  it('does not release another queued script on a replayed assistant final and cancels queued readouts on close', async () => {
    await scenario(async (fixture, events, close) => {
      for (const [index, id] of ['A', 'B', 'C'].entries()) {
        wire.liveEvent?.(userTurn(id, '質問 ' + id))
        fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[index][0], turn: 1 })
        fixture.pushAndEmit(assistantEvent(1, index + 1, '回答 ' + id))
      }
      end(fixture, 1)
      await flush()
      expect(speech()).toEqual(['回答 A'])
      const done: LiveServerEvent = { type: 'turn.done', turn: { id: 'readout-A', role: 'assistant', transcript: '回答 A' } }
      wire.liveEvent?.(done)
      await flush()
      expect(speech()).toEqual(['回答 A', '回答 B'])
      wire.liveEvent?.(done)
      await flush()
      expect(speech()).toEqual(['回答 A', '回答 B'])
      wire.liveEvent?.({ type: 'turn.created', turn: { id: 'new-user', role: 'user', transcript: '' } })
      expect(events.filter(event => event.type === 'playback').at(-1)).toEqual({ type: 'playback', enabled: false })
      await close()
      wire.liveEvent?.({ type: 'turn.done', turn: { id: 'readout-B', role: 'assistant', transcript: '回答 B' } })
      await flush()
      expect(speech()).toEqual(['回答 A', '回答 B'])
    })
  })

  it('waits for actual final ASR, preserves its late tail, and ignores model delegations', async () => {
    await scenario(async (fixture, events) => {
      wire.liveEvent?.({ type: 'input_transcript.added', item: { text: 'A かな' } })
      wire.liveEvent?.({ type: 'turn.created', turn: { id: 'user-A', role: 'user', transcript: 'A かな' } })
      wire.liveEvent?.({ type: 'output_transcript.added', item: { text: 'A ですね。' } })
      wire.liveEvent?.(modelDelegation('model-A', 'Choose option A'))
      wire.liveEvent?.({ type: 'input_transcript.added', item: { text: '、まだ変えないで。' } })
      expect(fixture.followup).not.toHaveBeenCalled()
      const exact = '  A かな、まだ変えないで。\nどう思う？  '
      wire.liveEvent?.(userTurn('user-A', exact))
      wire.liveEvent?.(userTurn('user-A', exact))
      wire.liveEvent?.(modelDelegation('model-B', 'Change to A'))
      expect(fixture.followup).toHaveBeenCalledOnce()
      expect(fixture.followup.mock.calls[0][0].content).toEqual([{ type: 'text', text: exact }])
      expect(latest(events, 'user-A')).toMatchObject({
        receipt: { input: exact, handoff: exact, context: [], status: 'queued' },
      })
      wire.liveEvent?.(userTurn('user-B', exact))
      expect(fixture.followup).toHaveBeenCalledTimes(2)
    })
  })

  it('forwards short follow-ups and greetings without local semantic filtering', async () => {
    await scenario(async fixture => {
      for (const [index, text] of ['Aかな', 'ありがとう', 'こんにちは', 'Hi', 'うん'].entries()) {
        wire.liveEvent?.(userTurn('user-' + index, text))
      }
      expect(fixture.followup.mock.calls.map(call => call[0].content[0].text))
        .toEqual(['Aかな', 'ありがとう', 'こんにちは', 'Hi', 'うん'])
      wire.liveEvent?.(userTurn('blank', ' \n '))
      wire.liveEvent?.({ type: 'turn.done', turn: { id: 'assistant', role: 'assistant', transcript: '返答です' } })
      expect(fixture.followup).toHaveBeenCalledTimes(5)
    })
  })

  it('deduplicates unkeyed finals but permits the same words after fresh speech', async () => {
    await scenario(async fixture => {
      wire.liveEvent?.(userTurn(undefined, 'もう一度'))
      wire.liveEvent?.(userTurn(undefined, 'もう一度'))
      expect(fixture.followup).toHaveBeenCalledOnce()
      wire.liveEvent?.({ type: 'turn.created', turn: { role: 'user', transcript: 'もう一度' } })
      wire.liveEvent?.(userTurn(undefined, 'もう一度'))
      wire.liveEvent?.(userTurn(undefined, 'もう一度'))
      expect(fixture.followup).toHaveBeenCalledTimes(2)
      wire.liveEvent?.(userTurn(undefined, '次は B'))
      expect(fixture.followup).toHaveBeenCalledTimes(3)
    })
  })

  it('steers exact ASR into active work and uses followup when no backend turn is open', async () => {
    await scenario(async (fixture, events) => {
      Object.assign(fixture.agent, { status: 'running' })
      wire.liveEvent?.(userTurn('before-turn', 'こんにちは'))
      expect(fixture.followup).toHaveBeenCalledOnce()
      fixture.events.push({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as SessionEvent)
      wire.liveEvent?.(userTurn('during-turn', 'やっぱり B かな'))
      expect(fixture.steer).toHaveBeenCalledOnce()
      expect(fixture.steer.mock.calls[0][0].content).toEqual([{ type: 'text', text: 'やっぱり B かな' }])
      expect(latest(events, 'during-turn')).toMatchObject({
        receipt: { route: 'steer', requestKind: 'additional', status: 'queued' },
      })
    })
  })

  it.each(['finish', 'discard-before', 'discard-after'] as const)('settles A independently of queued B: %s', async action => {
    await scenario(async (fixture, events) => {
      wire.liveEvent?.(userTurn('A', 'first question'))
      const a = fixture.followup.mock.calls[0][0]
      fixture.emit('agent/inbox/claimed', { message: a, turn: 1 })
      wire.liveEvent?.(userTurn('B', 'second question'))
      const b = fixture.followup.mock.calls[1][0]
      if (action === 'discard-before') fixture.emit('agent/inbox/discarded', { message: b })
      fixture.pushAndEmit(assistantEvent(1, 1, 'original answer'))
      end(fixture, 1)
      await flush()
      await finishSpeech()
      expect(payload()).toContain('original answer')
      expect(latest(events, 'A')).toMatchObject({ receipt: { status: 'replied' } })
      if (action === 'finish') {
        expect(latest(events, 'B')).toMatchObject({ receipt: { status: 'queued' } })
        expect(events.filter(event => event.type === 'phase').at(-1)).toMatchObject({ phase: 'working' })
        fixture.emit('agent/inbox/claimed', { message: b, turn: 2 })
        fixture.pushAndEmit(assistantEvent(2, 1, 'second answer'))
        end(fixture, 2)
        await flush()
        expect(speech()).toEqual(['original answer', 'second answer'])
        expect(latest(events, 'B')).toMatchObject({ receipt: { status: 'replied' } })
      } else {
        if (action === 'discard-after') fixture.emit('agent/inbox/discarded', { message: b })
        await flush()
        expect(speech()).toEqual(action === 'discard-before'
          ? ['The request was discarded.', 'original answer']
          : ['original answer', 'The request was discarded.'])
        expect(latest(events, 'B')).toMatchObject({ receipt: { status: 'discarded' } })
      }
      expect(events.filter(event => event.type === 'phase').at(-1)).toMatchObject({ phase: 'listening' })
      expect(wire.sentMessages.every(message => message.type === 'session.context.append')).toBe(true)
    })
  })

  it('reads a shared answer once as plain text and settles both UI receipts', async () => {
    await scenario(async (fixture, events) => {
      for (const [index, id] of ['A', 'B'].entries()) {
        wire.liveEvent?.(userTurn(id, 'question ' + id))
        fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[index][0], turn: 1 })
      }
      fixture.pushAndEmit(assistantEvent(1, 1, 'combined answer'))
      end(fixture, 1)
      await flush()
      expect(payload()).toBe('combined answer')
      for (const id of ['A', 'B']) {
        expect(latest(events, id)).toMatchObject({ receipt: { status: 'replied' } })
      }
    })
  })

  it.each([
    [{ kind: 'aborted' }, 'cancelled', 'The request was cancelled.'],
    [{ kind: 'blocked' }, 'blocked', 'The request was blocked.'],
    [{ kind: 'interrupted' }, 'interrupted', 'The response was interrupted.'],
    [{ kind: 'max-tokens' }, 'max-tokens', 'The response reached its token limit.'],
    [{ kind: 'error', error: { message: 'fixture failed', code: 'FIXTURE' } }, 'failed', 'The request failed: fixture failed'],
  ] as [EndReason, string, string][])('reports %s despite earlier ordinary text', async (reason, status, notice) => {
    await scenario(async (fixture, events) => {
      wire.liveEvent?.(userTurn('A', 'question'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      fixture.pushAndEmit(assistantEvent(1, 1, 'partial result'))
      end(fixture, 1, reason)
      await flush()
      expect(payload()).toBe(notice + '\n\npartial result')
      expect(latest(events, 'A')).toMatchObject({ receipt: { status } })
    })
  })

  it('does not treat tool commentary as an answer and reports no-reply', async () => {
    await scenario(async (fixture, events) => {
      wire.liveEvent?.(userTurn('A', 'question'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      const event = assistantEvent(1, 1, 'searching')
      if (event.type !== 'assistant/message') throw new Error('fixture')
      fixture.pushAndEmit({ ...event, data: { ...event.data, message: createAssistantMessage({
        content: [
          { type: 'text', text: 'searching' },
          { type: 'tool-call', id: ToolCallId('tool'), name: 'search', arguments: {} },
        ],
        source: { provider: 'mock', model: 'mock' },
      }) } })
      end(fixture, 1)
      await flush()
      expect(payload()).toBe('The backend returned no text.')
      expect(payload(true)).toContain('searching')
      expect(latest(events, 'A')).toMatchObject({ receipt: { status: 'no-reply' } })
    })
  })

  it('ignores unrelated events and replay without losing multiple answers', async () => {
    await scenario(async fixture => {
      wire.liveEvent?.(userTurn('A', 'question'))
      fixture.emit('agent/inbox/claimed', { message: createUserMessage({ content: [] }), turn: 7 })
      fixture.pushAndEmit(assistantEvent(7, 1, 'unrelated'))
      end(fixture, 7)
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      const first = assistantEvent(1, 1, 'first answer')
      fixture.pushAndEmit(first)
      fixture.pushAndEmit(first)
      fixture.pushAndEmit(assistantEvent(1, 2, 'second answer'))
      end(fixture, 1)
      await flush()
      expect(payload()).toBe('first answer\n\nsecond answer')
      end(fixture, 1)
      await flush()
      expect(payload()).toBe('first answer\n\nsecond answer')
    })
  })

  it('keeps tracking-stopped in the UI without injecting shutdown instructions into voice', async () => {
    await scenario(async (fixture, events, close) => {
      wire.liveEvent?.(userTurn('A', 'question'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      await close()
      expect(payload(true)).toBe('')
      expect(latest(events, 'A')).toMatchObject({ receipt: { status: 'tracking-stopped' } })
    })
  })

  it('passes the complete backend answer as bounded session context chunks', async () => {
    await scenario(async fixture => {
      wire.liveEvent?.(userTurn('A', '詳しく教えて'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      await flush()
      expect(payload(true)).toBe('')
      const answer = '説明です。\n\n' + 'この段落を省略せずに読み上げます。'.repeat(500)
        + '\n\n1. 条件は A です。\n2. 次に B を確認します。'
      fixture.pushAndEmit(assistantEvent(1, 1, answer))
      end(fixture, 1)
      await flush()
      expect(payload()).toBe(answer)
      expect(speakableCues()).toHaveLength(1)
      expect(wire.sentMessages.every(message => !('content' in message)
        || message.content.every(block => Buffer.byteLength(block.text) <= 500))).toBe(true)
      const cue = wire.sentMessages.at(-1)
      expect(cue).toMatchObject({ type: 'session.context.append', channel: 'speakable' })
      expect(wire.sentMessages.slice(0, -1).every(message => message.type === 'session.context.append'
        && message.channel === 'commentary')).toBe(true)
      expect(wire.sentMessages.every(message => message.type === 'session.context.append')).toBe(true)
    })
  })

  it('reads in backend response order when requests are claimed out of creation order', async () => {
    await scenario(async fixture => {
      wire.liveEvent?.(userTurn('A', 'question A'))
      wire.liveEvent?.(userTurn('B', 'question B'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[1][0], turn: 1 })
      fixture.pushAndEmit(assistantEvent(1, 1, 'First: B'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      fixture.pushAndEmit(assistantEvent(1, 2, 'Second: A'))
      end(fixture, 1)
      await flush()
      expect(speech()).toEqual(['First: B'])
      await finishSpeech()
      expect(speech()).toEqual(['First: B', 'Second: A'])
    })
  })

  it('reads identical answers to separate turns instead of suppressing repeated words', async () => {
    await scenario(async fixture => {
      for (const [index, id] of ['A', 'B'].entries()) {
        wire.liveEvent?.(userTurn(id, 'もう一度教えて'))
        fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[index][0], turn: index + 1 })
        fixture.pushAndEmit(assistantEvent(index + 1, index + 1, 'はい。'))
        end(fixture, index + 1)
        await flush()
        await finishSpeech()
      }
      expect(speech()).toEqual(['はい。', 'はい。'])
    })
  })

  it('preserves sequential A and B replies in one backend turn with separate receipts', async () => {
    await scenario(async (fixture, events) => {
      wire.liveEvent?.(userTurn('A', 'Request A'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[0][0], turn: 1 })
      wire.liveEvent?.(userTurn('B', 'Request B'))
      fixture.pushAndEmit(assistantEvent(1, 1, 'Answer A'))
      fixture.emit('agent/inbox/claimed', { message: fixture.followup.mock.calls[1][0], turn: 1 })
      fixture.pushAndEmit(assistantEvent(1, 2, 'Answer B'))
      end(fixture, 1)
      await flush()
      expect(speech()).toEqual(['Answer A'])
      expect(speakableCues()).toHaveLength(1)
      await finishSpeech()
      expect(speech()).toEqual(['Answer A', 'Answer B'])
      expect(speakableCues()).toHaveLength(2)
      expect(latest(events, 'A')).toMatchObject({ receipt: { status: 'replied' } })
      expect(latest(events, 'B')).toMatchObject({ receipt: { status: 'replied' } })
    })
  })
})
