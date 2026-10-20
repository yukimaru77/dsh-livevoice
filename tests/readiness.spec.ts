import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: vi.fn(), start: vi.fn(), stop: vi.fn(), subscribe: vi.fn(),
  peer: vi.fn(), accept: vi.fn(), levels: vi.fn(), playback: vi.fn(),
  activity: vi.fn(),
}))
vi.mock('../src/client/api.js', () => {
  class LiveCallError extends Error {
    readonly kind: string
    constructor(message: string, kind = 'unknown') {
      super(message)
      this.name = 'LiveCallError'
      this.kind = kind
    }
  }
  return {
    fetchLiveStatus: mocks.status,
    startLiveCall: mocks.start,
    stopLiveCall: mocks.stop,
    subscribeLiveEvents: mocks.subscribe,
    LiveCallError,
    sendLiveInputActivity: mocks.activity,
  }
})
vi.mock('../src/client/webrtc.js', () => ({ createLivePeer: mocks.peer, acceptLiveAnswer: mocks.accept }))
vi.mock('../src/client/levels.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/levels.js')>(),
  createLevelMonitor: mocks.levels,
}))
vi.mock('../src/client/playback.js', () => ({ unlockPlayback: mocks.playback }))
import { LiveClientSession } from '../src/client/session.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function peer() {
  return { captureLabel: 'fixture mic', localStream: {}, isMicrophoneUsable: vi.fn(() => true), setMuted: vi.fn(), close: vi.fn() }
}
type Callbacks = {
  onControlPayload(payload: string): void
  onIceState(state: string): void
  onRemoteStream(stream: unknown): void
  onMicrophoneEnded(): void
}
let sessions: LiveClientSession[]
let control: Callbacks
let event: (value: unknown) => void
let media: ReturnType<typeof deferred<void>>
let currentPeer: ReturnType<typeof peer>

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
  })
  sessions = []
  media = deferred<void>()
  currentPeer = peer()
  mocks.status.mockResolvedValue({ ready: true })
  mocks.start.mockResolvedValue({ callToken: 'fixture-token', answer: 'fixture-answer' })
  mocks.stop.mockResolvedValue(undefined)
  mocks.activity.mockResolvedValue(undefined)
  mocks.subscribe.mockImplementation((_token, callback) => { event = callback; return vi.fn() })
  mocks.peer.mockImplementation(async callbacks => { control = callbacks; return { peer: currentPeer, offer: 'fixture-offer' } })
  mocks.accept.mockImplementation(() => media.promise)
  mocks.levels.mockReturnValue(vi.fn())
  mocks.playback.mockReturnValue({ attach: vi.fn(), retry: vi.fn(), stop: vi.fn() })
})
afterEach(async () => {
  for (const session of sessions) await session.stop()
  media.resolve()
  await settle()
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function session() { const result = new LiveClientSession('fixture-session'); sessions.push(result); return result }
function sampleInput(level: number, from: number, to: number): void {
  const observer = mocks.levels.mock.calls.at(-1)![2] as (level: number, now: number) => void
  for (let now = from; now <= to; now += 50) observer(level, now)
}

describe('microphone activity reporting', () => {
  it('reports raw acoustic boundaries only after connection and never submits on mute', async () => {
    const live = session(); const starting = live.start(); await settle()
    sampleInput(0.03, 0, 500)
    sampleInput(0, 550, 3_000)
    expect(mocks.activity).not.toHaveBeenCalled()
    event({ type: 'ready' }); media.resolve(); await starting
    sampleInput(0, 3_050, 5_000)
    expect(mocks.activity).not.toHaveBeenCalled()
    sampleInput(0.03, 5_050, 5_300)
    expect(mocks.activity).toHaveBeenLastCalledWith('fixture-token', 1, true)

    live.toggleMute()
    sampleInput(0, 5_350, 8_000)
    live.toggleMute()
    sampleInput(0, 8_050, 10_000)
    expect(mocks.activity).toHaveBeenCalledTimes(1)
    sampleInput(0.03, 10_050, 10_300)
    sampleInput(0, 10_350, 12_150)
    expect(mocks.activity.mock.calls).toEqual([
      ['fixture-token', 1, true],
      ['fixture-token', 2, true],
      ['fixture-token', 3, false],
    ])
    const oldObserver = mocks.levels.mock.calls.at(-1)![2]
    await live.stop()
    oldObserver(0.03, 13_000); oldObserver(0.03, 13_200)
    expect(mocks.activity).toHaveBeenCalledTimes(3)
  })

  it('shows an activity request failure and releases the call so it can be retried', async () => {
    const live = session(); const starting = live.start(); await settle()
    event({ type: 'ready' }); media.resolve(); await starting
    mocks.activity.mockRejectedValueOnce(new Error('HTTP 503'))
    sampleInput(0.03, 0, 250); await settle()
    expect(live.snapshot.phase).toBe('idle')
    expect(live.snapshot.error).toMatch(/microphone activity.*HTTP 503/)
    expect(live.snapshot.errorKind).toBe('network')
    expect(currentPeer.close).toHaveBeenCalledOnce()
  })

  it('ignores a rejected activity request from a previous call generation', async () => {
    let reject!: (error: Error) => void
    mocks.activity.mockReturnValueOnce(new Promise<void>((_resolve, no) => { reject = no }))
    const live = session(); const starting = live.start(); await settle()
    event({ type: 'ready' }); media.resolve(); await starting
    sampleInput(0.03, 0, 250)
    await live.stop()
    currentPeer = peer()
    const retry = live.start(); await settle()
    event({ type: 'ready' }); await retry
    reject(new Error('late failure')); await settle()
    expect(live.snapshot.phase).toBe('listening')
    expect(live.snapshot.error).toBeUndefined()
    sampleInput(0.03, 300, 550)
    expect(mocks.activity).toHaveBeenLastCalledWith('fixture-token', 1, true)
  })
})

describe('live call readiness follows evidence, never elapsed time or mute state', () => {
  it('fails and releases resources when media connects but no service proof arrives', async () => {
    const live = session()
    const starting = live.start()
    await settle(); media.resolve(); await settle()
    expect(live.snapshot.phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(20_001)
    await starting
    expect(live.snapshot.phase).toBe('idle')
    expect(live.snapshot.error).toBeTruthy()
    expect(currentPeer.close).toHaveBeenCalledOnce()
    expect(mocks.stop).toHaveBeenCalledWith('fixture-token')
  })

  it('mute and unmute cannot bypass incomplete media/service readiness', async () => {
    const live = session(); void live.start(); await settle()
    live.toggleMute()
    expect(live.snapshot.muted).toBe(true)
    expect(live.snapshot.phase).toBe('connecting')
    live.toggleMute()
    expect(live.snapshot.muted).toBe(false)
    expect(live.snapshot.phase).toBe('connecting')
  })

  it('does not promote backend activity to service readiness or completed media', async () => {
    const live = session(); const starting = live.start(); await settle()
    event({ type: 'phase', phase: 'working' })
    expect(live.snapshot.phase).toBe('connecting')
    media.resolve(); await settle()
    expect(live.snapshot.phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(20_001); await starting
    expect(live.snapshot.phase).toBe('idle')
  })

  it('remembers early data-channel proof but only announces readiness after media connects', async () => {
    const live = session(); const starting = live.start(); await settle()
    control.onControlPayload(JSON.stringify({ type: 'session.started', session: { id: 'fixture-service' } }))
    expect(live.snapshot.phase).toBe('connecting')
    media.resolve(); await starting
    expect(live.snapshot.phase).toBe('listening')
    expect(live.snapshot.dialStartedAt).toBeUndefined()
    expect(currentPeer.setMuted).toHaveBeenLastCalledWith(false)
  })

  it('accepts explicit backend ready proof without waiting for a transcript or timeout', async () => {
    const live = session(); const starting = live.start(); await settle()
    media.resolve(); await settle()
    event({ type: 'ready' }); await settle()
    expect(live.snapshot.phase).toBe('listening')
    await starting
  })

  it('preserves user mute on successful connection', async () => {
    const live = session(); const starting = live.start(); await settle()
    live.toggleMute()
    control.onControlPayload(JSON.stringify({ type: 'session.started' }))
    media.resolve(); await starting
    expect(live.snapshot.phase).toBe('muted')
    expect(currentPeer.setMuted).toHaveBeenLastCalledWith(true)
  })

  it('does not announce readiness if the microphone ended during negotiation', async () => {
    const live = session(); const starting = live.start(); await settle()
    currentPeer.isMicrophoneUsable.mockReturnValue(false)
    event({ type: 'ready' }); media.resolve(); await starting
    expect(live.snapshot.phase).toBe('idle')
    expect(live.snapshot.error).toMatch(/Microphone/)
    expect(currentPeer.close).toHaveBeenCalledOnce()
    expect(mocks.stop).toHaveBeenCalledWith('fixture-token')
  })

  it('leaves Ready when capture ends after connection and allows a fresh retry', async () => {
    const live = session(); const starting = live.start(); await settle()
    event({ type: 'ready' }); media.resolve(); await starting
    expect(live.snapshot.phase).toBe('listening')
    const previousControl = control
    const previousPeer = currentPeer

    control.onMicrophoneEnded()
    await settle()
    expect(live.snapshot.phase).toBe('idle')
    expect(live.snapshot.error).toMatch(/Microphone capture ended.*try again/)
    expect(live.snapshot.errorKind).toBe('media')
    expect(previousPeer.close).toHaveBeenCalledOnce()
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.stop).toHaveBeenCalledWith('fixture-token')

    currentPeer = peer()
    const retry = live.start(); await settle()
    event({ type: 'ready' }); await retry
    expect(live.snapshot.phase).toBe('listening')
    expect(live.snapshot.error).toBeUndefined()
    previousControl.onMicrophoneEnded()
    expect(live.snapshot.phase).toBe('listening')
    expect(currentPeer.close).not.toHaveBeenCalled()
  })
})

describe('cancelled dial generations cannot resurrect calls', () => {
  it('closes a microphone peer that arrives after cancellation without starting a server call', async () => {
    const pending = deferred<{ peer: ReturnType<typeof peer>; offer: string }>()
    mocks.peer.mockReturnValueOnce(pending.promise)
    const live = session(); const starting = live.start(); await settle()
    await live.stop()
    pending.resolve({ peer: currentPeer, offer: 'late-offer' }); await settle()
    expect(currentPeer.close).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(live.snapshot.phase).toBe('idle')
    await starting
  })

  it('closes a server call that arrives after cancellation and never subscribes it', async () => {
    const pending = deferred<{ callToken: string; answer: string }>()
    mocks.start.mockReturnValueOnce(pending.promise)
    const live = session(); const starting = live.start(); await settle()
    await live.stop(); pending.resolve({ callToken: 'late-token', answer: 'late-answer' }); await settle()
    expect(mocks.stop).toHaveBeenCalledWith('late-token')
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(live.snapshot.phase).toBe('idle')
    await starting
  })
})
