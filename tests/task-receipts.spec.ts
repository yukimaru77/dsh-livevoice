import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CodexAccess } from '../src/auth.ts'
import type { LiveProxy } from '../src/proxy.ts'
import type { LiveServerEvent } from '../src/protocol.ts'
import {
  mergeLiveTaskReceipt,
  stopTrackingLiveTaskReceipts,
  type LiveTaskReceipt,
} from '../src/receipts.ts'

const wire = vi.hoisted(() => ({
  liveEvent: undefined as undefined | ((event: LiveServerEvent) => void),
}))

vi.mock('../src/signaling.js', () => ({
  signalLiveCall: async () => ({ callId: 'fixture-call', answer: 'fixture-answer' }),
}))
vi.mock('../src/sideband.js', () => ({
  LiveSideband: class {
    constructor(_access: unknown, _session: unknown, _realtime: unknown, _proxy: unknown,
      handlers: { onEvent(event: LiveServerEvent): void }) { wire.liveEvent = handlers.onEvent }
    async connect() {}
    async close() {}
    async send() {}
  },
}))

import { LiveCallRegistry, type LiveUiEvent } from '../src/controller.ts'

type Handler = (...args: any[]) => void

function fixtureAgent() {
  const handlers = new Map<string, Handler[]>()
  const events: SessionEvent[] = []
  const followup = vi.fn()
  const steer = vi.fn()
  const session = {
    id: 'fixture-session',
    snapshotEvents: () => events,
  }
  const agent = {
    status: 'idle',
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
    emit(name: string, ...args: unknown[]) {
      for (const handler of handlers.get(name) ?? []) handler(...args)
    },
  }
}

function userTurn(id: string, text: string): LiveServerEvent {
  return { type: 'turn.done', turn: { id, role: 'user', transcript: text } }
}

beforeEach(() => { wire.liveEvent = undefined })

describe('ASR task receipt walking skeleton', () => {
  it('flows controller dispatch through replayable SSE events into client receipt state', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    const events: LiveUiEvent[] = []
    call.subscribe(event => events.push(event))
    try {
      wire.liveEvent?.(userTurn('delegation-1', 'How would you optimize this without changing it?'))

      expect(fixture.followup).toHaveBeenCalledOnce()
      const sent = fixture.followup.mock.calls[0]?.[0]
      expect(sent.content[0].text).toBe('How would you optimize this without changing it?')

      const queued = events.find((event): event is Extract<LiveUiEvent, { type: 'task-receipt' }> =>
        event.type === 'task-receipt' && event.receipt.status === 'queued')
      expect(queued?.receipt).toMatchObject({
        id: 'delegation-1',
        input: 'How would you optimize this without changing it?',
        requestKind: 'new',
        route: 'followup',
        status: 'queued',
      })

      const replay: LiveUiEvent[] = []
      call.subscribe(event => replay.push(event))()
      const replayed = replay.find((event): event is Extract<LiveUiEvent, { type: 'task-receipt' }> =>
        event.type === 'task-receipt')
      if (!replayed) throw new Error('expected replayed task receipt')
      const sseFrame = JSON.parse(JSON.stringify(replayed)) as typeof replayed
      let clientReceipts: readonly LiveTaskReceipt[] = []
      clientReceipts = mergeLiveTaskReceipt(clientReceipts, sseFrame.receipt)
      expect(clientReceipts).toEqual([queued?.receipt])

      fixture.emit('agent/inbox/claimed', { message: sent, turn: 7 })
      expect(events).toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({ id: 'delegation-1', status: 'running', claimedTurn: 7 }),
      })

      fixture.emit('session/event', fixture.session, {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: {
          turn: 7,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Here is the analysis; no files changed.' }],
            source: { provider: 'mock', model: 'mock' },
          }),
        },
      })
      fixture.emit('session/event', fixture.session, {
        type: 'turn/end',
        seq: 2,
        time: 2,
        data: { turn: 7, reason: { kind: 'completed' } },
      } satisfies SessionEvent)
      expect(events).toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({ id: 'delegation-1', status: 'replied' }),
      })
    } finally {
      await call.close()
    }
  })

  it('dispatches one message per item id while allowing repeated text under a new id', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    try {
      const first = userTurn('same-id', 'Run tests')
      wire.liveEvent?.(first)
      wire.liveEvent?.(first)
      wire.liveEvent?.(userTurn('new-id', 'Run tests'))
      expect(fixture.followup).toHaveBeenCalledTimes(2)
    } finally {
      await call.close()
    }
  })

  it('stores exact ASR and no added history in the replayable receipt', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    const events: LiveUiEvent[] = []
    call.subscribe(event => events.push(event))
    try {
      wire.liveEvent?.(userTurn('previous', '以前の質問です'))
      const current = '  今回の発話です。\n' + '続き'.repeat(4_000) + '  '
      wire.liveEvent?.({ type: 'input_transcript.added', item: { text: current } })
      expect(fixture.followup).toHaveBeenCalledOnce()
      wire.liveEvent?.(userTurn('current', current))
      expect(fixture.followup.mock.calls[1][0].content[0].text).toBe(current)
      expect(events).toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({
          id: 'current',
          input: current,
          handoff: current,
          context: [],
          requestKind: 'additional',
        }),
      })
    } finally {
      await call.close()
    }
  })

  it('marks a claimed turn with no assistant text as no-reply', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    const events: LiveUiEvent[] = []
    call.subscribe(event => events.push(event))
    try {
      wire.liveEvent?.(userTurn('no-reply', 'Check status'))
      const sent = fixture.followup.mock.calls[0]?.[0]
      fixture.emit('agent/inbox/claimed', { message: sent, turn: 8 })
      fixture.emit('session/event', fixture.session, {
        type: 'turn/end',
        seq: 1,
        time: 1,
        data: { turn: 8, reason: { kind: 'completed' } },
      } satisfies SessionEvent)
      expect(events).toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({ id: 'no-reply', status: 'no-reply' }),
      })
    } finally {
      await call.close()
    }
  })

  it('does not regress a synchronously claimed or discarded receipt back to queued', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    const events: LiveUiEvent[] = []
    call.subscribe(event => events.push(event))
    try {
      fixture.followup.mockImplementationOnce(message => {
        fixture.emit('agent/inbox/claimed', { message, turn: 9 })
      })
      wire.liveEvent?.(userTurn('sync-claimed', 'Inspect the state'))
      const claimedStatuses = events
        .filter((event): event is Extract<LiveUiEvent, { type: 'task-receipt' }> =>
          event.type === 'task-receipt' && event.receipt.id === 'sync-claimed')
        .map(event => event.receipt.status)
      expect(claimedStatuses).toEqual(['queued', 'running'])

      fixture.followup.mockImplementationOnce(message => {
        fixture.emit('agent/inbox/discarded', { message })
      })
      wire.liveEvent?.(userTurn('sync-discarded', 'Inspect the state again'))
      const discardedStatuses = events
        .filter((event): event is Extract<LiveUiEvent, { type: 'task-receipt' }> =>
          event.type === 'task-receipt' && event.receipt.id === 'sync-discarded')
        .map(event => event.receipt.status)
      expect(discardedStatuses).toEqual(['queued', 'discarded'])
      expect(events.slice(events.findIndex(event => event.type === 'task-receipt'
        && event.receipt.id === 'sync-discarded')).filter(event => event.type === 'phase'))
        .not.toContainEqual({ type: 'phase', phase: 'working' })
    } finally {
      await call.close()
    }
  })

  it('uses the real turn-end reason and never promotes a failed turn with text to replied', async () => {
    const fixture = fixtureAgent()
    const registry = new LiveCallRegistry(
      () => fixture.agent,
      async () => ({} as CodexAccess),
      {} as LiveProxy,
    )
    const call = await registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
    const events: LiveUiEvent[] = []
    call.subscribe(event => events.push(event))
    try {
      wire.liveEvent?.(userTurn('failed-turn', 'Inspect the failure'))
      const sent = fixture.followup.mock.calls[0]?.[0]
      fixture.emit('agent/inbox/claimed', { message: sent, turn: 10 })
      fixture.events.push({
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: {
          turn: 10,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Partial text before failure.' }],
            source: { provider: 'mock', model: 'mock' },
          }),
        },
      })
      fixture.emit('session/event', fixture.session, {
        type: 'turn/end',
        seq: 2,
        time: 2,
        data: { turn: 10, reason: { kind: 'error', error: { message: 'fixture failed', code: 'FIXTURE' } } },
      } satisfies SessionEvent)
      expect(events).toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({ id: 'failed-turn', status: 'failed', error: 'fixture failed' }),
      })
      expect(events).not.toContainEqual({
        type: 'task-receipt',
        receipt: expect.objectContaining({ id: 'failed-turn', status: 'replied' }),
      })
    } finally {
      await call.close()
    }
  })

  it('keeps every active client receipt and only the 24 most recent settled receipts', () => {
    let receipts: readonly LiveTaskReceipt[] = []
    for (let index = 0; index < 30; index += 1) {
      receipts = mergeLiveTaskReceipt(receipts, receipt(`settled-${index}`, 'replied', index))
    }
    receipts = mergeLiveTaskReceipt(receipts, receipt('queued', 'queued', 31))
    receipts = mergeLiveTaskReceipt(receipts, receipt('running', 'running', 32))
    expect(receipts.filter(item => item.status === 'replied')).toHaveLength(24)
    expect(receipts.map(item => item.id)).toContain('queued')
    expect(receipts.map(item => item.id)).toContain('running')
  })

  it('freezes active page-local receipts when the call stops', () => {
    const receipts = [
      receipt('queued', 'queued', 1),
      receipt('running', 'running', 2),
      receipt('replied', 'replied', 3),
    ]
    expect(stopTrackingLiveTaskReceipts(receipts, 10).map(item => [item.id, item.status])).toEqual([
      ['queued', 'tracking-stopped'],
      ['running', 'tracking-stopped'],
      ['replied', 'replied'],
    ])
  })
})

function receipt(id: string, status: LiveTaskReceipt['status'], timestamp: number): LiveTaskReceipt {
  return {
    id,
    input: id,
    handoff: id,
    context: [],
    requestKind: 'new',
    route: 'followup',
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
