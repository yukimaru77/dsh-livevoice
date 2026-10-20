import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CodexAccess } from '../src/auth.ts'
import type { LiveProxy } from '../src/proxy.ts'
import type { LiveServerEvent } from '../src/protocol.ts'

const wire = vi.hoisted(() => ({
  event: undefined as undefined | ((event: LiveServerEvent) => void),
  proofOnConnect: false,
}))
vi.mock('../src/signaling.js', () => ({ signalLiveCall: async () => ({ callId: 'fixture-call', answer: 'fixture-answer' }) }))
vi.mock('../src/sideband.js', () => ({
  LiveSideband: class {
    constructor(_access: unknown, _session: unknown, _realtime: unknown, _proxy: unknown,
      handlers: { onEvent(event: LiveServerEvent): void }) { wire.event = handlers.onEvent }
    async connect() {
      if (wire.proofOnConnect) wire.event?.({ type: 'session.updated', session: { id: 'fixture-service' } })
    }
    async close() {}
    async send() {}
  },
}))
import { LiveCallRegistry } from '../src/controller.ts'

async function call(proofOnConnect = false) {
  wire.proofOnConnect = proofOnConnect
  // These boundaries are never used for LLM work, auth or network in this test.
  const agent = { ctx: { on: () => () => {} } } as unknown as Agent
  const registry = new LiveCallRegistry(() => agent, async () => ({} as CodexAccess), {} as LiveProxy)
  return registry.start({ sessionId: 'fixture-session', offer: 'fixture-offer' })
}

describe('backend readiness is a distinct replayable proof', () => {
  it('does not announce listening when only the sideband transport opens', async () => {
    const live = await call()
    try {
      const events: unknown[] = []
      live.subscribe(event => events.push(event))
      expect(events).toEqual([{ type: 'playback', enabled: false }, { type: 'phase', phase: 'connecting' }])
      wire.event?.({ type: 'session.started', session: { id: 'fixture-service' } })
      expect(events).toContainEqual({ type: 'ready' })
      expect(events).toContainEqual({ type: 'phase', phase: 'listening' })
      const replay: unknown[] = []
      live.subscribe(event => replay.push(event))
      expect(replay).toContainEqual({ type: 'ready' })
    } finally { await live.close() }
  })

  it('replays proof received before the browser has subscribed', async () => {
    const live = await call(true)
    try {
      const events: unknown[] = []
      live.subscribe(event => events.push(event))
      expect(events).toContainEqual({ type: 'ready' })
      expect(events).toContainEqual({ type: 'phase', phase: 'listening' })
    } finally { await live.close() }
  })
})
