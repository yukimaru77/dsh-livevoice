import { describe, expect, it } from 'vitest'
import { InputActivityDetector, meterHeights, shouldGateEcho, smoothLevel } from '../src/client/levels.ts'

function observeFor(detector: InputActivityDetector, level: number, from: number, to: number, enabled = true): boolean[] {
  const events: boolean[] = []
  for (let now = from; now <= to; now += 50) {
    const event = detector.observe(level, now, enabled)
    if (event !== undefined) events.push(event)
  }
  return events
}

describe('local input activity', () => {
  it('ignores startup silence and isolated clicks, then emits one start and one end for speech', () => {
    const detector = new InputActivityDetector()
    expect(observeFor(detector, 0, 0, 2_000)).toEqual([])
    expect(detector.observe(0.5, 2_050)).toBeUndefined()
    expect(observeFor(detector, 0, 2_100, 2_600)).toEqual([])
    expect(observeFor(detector, 0.03, 2_650, 2_850)).toEqual([true])
    expect(observeFor(detector, 0.03, 2_900, 3_500)).toEqual([])
    expect(observeFor(detector, 0, 3_550, 5_300)).toEqual([])
    expect(detector.observe(0, 5_350)).toBe(false)
    expect(observeFor(detector, 0, 5_400, 8_000)).toEqual([])
  })

  it('keeps an utterance open across brief pauses and detects a later utterance', () => {
    const detector = new InputActivityDetector()
    expect(observeFor(detector, 0.03, 0, 250)).toEqual([true])
    expect(observeFor(detector, 0, 300, 1_000)).toEqual([])
    expect(observeFor(detector, 0.03, 1_050, 1_500)).toEqual([])
    expect(observeFor(detector, 0, 1_550, 3_350)).toEqual([false])
    expect(observeFor(detector, 0.03, 3_400, 3_650)).toEqual([true])
  })

  it('resets when capture is disabled without treating mute as an utterance end', () => {
    const detector = new InputActivityDetector()
    expect(observeFor(detector, 0.03, 0, 500, false)).toEqual([])
    expect(observeFor(detector, 0.03, 550, 800)).toEqual([true])
    expect(observeFor(detector, 0, 850, 3_000, false)).toEqual([])
    expect(observeFor(detector, 0, 3_050, 5_000)).toEqual([])
    expect(observeFor(detector, 0.03, 5_050, 5_300)).toEqual([true])
  })

  it('does not count an unobserved background-frame gap as sustained speech or silence', () => {
    const detector = new InputActivityDetector()
    expect(detector.observe(0.03, 0)).toBeUndefined()
    expect(detector.observe(0.03, 10_000)).toBeUndefined()
    expect(observeFor(detector, 0.03, 10_050, 10_250)).toEqual([true])
    expect(detector.observe(0, 20_000)).toBeUndefined()
    expect(observeFor(detector, 0, 20_050, 21_750)).toEqual([])
    expect(detector.observe(0, 21_800)).toBe(false)
  })
})

describe('echo gate', () => {
  it('drops quiet mic samples while the speaker is active', () => {
    expect(shouldGateEcho(0.02, 0.2)).toBe(true)
  })

  it('lets barge-in through', () => {
    expect(shouldGateEcho(0.3, 0.2)).toBe(false)
  })

  it('passes mic audio when the speaker is idle', () => {
    expect(shouldGateEcho(0.02, 0)).toBe(false)
  })
})

describe('meter heights', () => {
  it('stays flat when the mic is silent so idle cannot look like capture', () => {
    expect(meterHeights(0)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(meterHeights(0.005)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('raises bars for quiet-but-real speech energy', () => {
    expect(meterHeights(0.02).some(height => height > 0)).toBe(true)
  })

  it('raises the center bars when there is real energy', () => {
    const bars = meterHeights(0.5)
    expect(bars[3]).toBeGreaterThan(bars[0] ?? 0)
    expect(bars.every(height => height > 0)).toBe(true)
  })
})

describe('level smoothing', () => {
  it('attacks faster than it releases', () => {
    const up = smoothLevel(0.1, 0.9)
    const down = smoothLevel(0.9, 0.1)
    expect(up - 0.1).toBeGreaterThan(0.9 - down)
    expect(up).toBeLessThan(0.9)
    expect(down).toBeGreaterThan(0.1)
  })
})
