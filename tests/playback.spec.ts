import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyRemotePlayback, unlockPlayback } from '../src/client/playback.ts'

afterEach(() => vi.unstubAllGlobals())

describe('remote playback', () => {
  it('puts the speaker at full volume instead of leaving a muted unlock element', () => {
    const stream = { id: 'remote' } as MediaStream
    const audio = { srcObject: null as MediaProvider | null, muted: true, volume: 0, autoplay: false }
    applyRemotePlayback(audio, stream)
    expect(audio.srcObject).toBe(stream)
    expect(audio.muted).toBe(false)
    expect(audio.volume).toBe(1)
    expect(audio.autoplay).toBe(true)
  })

  it('keeps unsolicited audio silent across attach and retry, then opens only for a backend readout', async () => {
    const audio = {
      autoplay: false, muted: false, volume: 1, src: '', srcObject: null,
      setAttribute: vi.fn(), play: vi.fn(async () => {}), pause: vi.fn(),
      removeAttribute: vi.fn(), remove: vi.fn(),
    }
    vi.stubGlobal('Audio', class { constructor() { return audio } })
    vi.stubGlobal('document', { body: { appendChild: vi.fn() } })
    const playback = unlockPlayback()
    playback.attach({ id: 'remote' } as MediaStream)
    playback.retry()
    expect(audio.muted).toBe(true)
    expect(audio.volume).toBe(0)
    playback.setEnabled(true)
    expect(audio.muted).toBe(false)
    expect(audio.volume).toBe(1)
    playback.setEnabled(false)
    playback.retry()
    expect(audio.muted).toBe(true)
    expect(audio.volume).toBe(0)
    playback.stop()
    expect(audio.pause).toHaveBeenCalledOnce()
  })

  it('applies the same gate to the Web Audio fallback', async () => {
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
    const source = { connect: vi.fn(), disconnect: vi.fn() }
    const audio = {
      autoplay: false, muted: false, volume: 1, src: '', srcObject: null,
      setAttribute: vi.fn(), play: vi.fn(async () => { throw Error('blocked') }), pause: vi.fn(),
      removeAttribute: vi.fn(), remove: vi.fn(),
    }
    vi.stubGlobal('Audio', class { constructor() { return audio } })
    vi.stubGlobal('document', { body: { appendChild: vi.fn() } })
    vi.stubGlobal('AudioContext', class {
      state = 'running'; destination = {}
      createMediaStreamSource() { return source }
      createGain() { return gain }
      async close() {}
    })
    const playback = unlockPlayback()
    playback.attach({ id: 'remote' } as MediaStream)
    await Promise.resolve()
    await Promise.resolve()
    expect(source.connect).toHaveBeenCalledWith(gain)
    expect(gain.gain.value).toBe(0)
    playback.setEnabled(true)
    expect(gain.gain.value).toBe(1)
    playback.setEnabled(false)
    expect(gain.gain.value).toBe(0)
    playback.stop()
  })
})
