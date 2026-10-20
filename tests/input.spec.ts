import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveInputBuffer } from '../src/input.ts'
import type { LiveServerEvent } from '../src/protocol.ts'

const created = (id: string, transcript: string): LiveServerEvent =>
  ({ type: 'turn.created', turn: { id, role: 'user', transcript } })
const done = (id: string, transcript: string): LiveServerEvent =>
  ({ type: 'turn.done', turn: { id, role: 'user', transcript } })
const handoff = (id: string): LiveServerEvent => ({
  type: 'delegation.created',
  item: { type: 'delegation', target: 'client', id: `delegation-${id}`, userTurnId: id,
    content: [{ type: 'input_text', text: 'MODEL REWRITE MUST NEVER BE SENT' }] },
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('raw ASR completion', () => {
  it.each([false, true])('retains ASR preceding an empty created event (early delegation: %s)', async early => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.setActivity(1, true)
    if (early) input.ingest(handoff('A'))
    input.ingest({ type: 'input_transcript.added', item: { text: '今' } })
    input.ingest(created('A', ''))
    input.ingest({ type: 'input_transcript.added', item: { text: 'すぐ' } })
    input.ingest({ type: 'turn.delta', turnId: 'A', delta: 'すぐ' })
    input.setActivity(2, false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(dispatch.mock.calls.map(([turn]) => turn.transcript)).toEqual(['今すぐ'])
    input.close()
  })

  it('does not graft an unkeyed assistant delta onto the pending user input', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.ingest(created('A', '確認して'))
    input.ingest({ type: 'turn.created', turn: { role: 'assistant', transcript: '' } })
    input.ingest({ type: 'turn.delta', delta: 'わかりました' })
    input.ingest(handoff('A'))
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatch.mock.calls[0][0].transcript).toBe('確認して')
    input.close()
  })

  it('keeps adjacent turn boundaries and late finals independent', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.ingest(created('A', '最初の質問'))
    input.ingest(handoff('A'))
    await vi.advanceTimersByTimeAsync(500)
    input.ingest(created('B', '次の質問'))
    input.ingest(handoff('B'))
    await vi.advanceTimersByTimeAsync(250)
    expect(dispatch.mock.calls.map(([turn]) => turn.transcript)).toEqual(['最初の質問'])
    input.ingest(done('A', '最初の質問'))
    await vi.advanceTimersByTimeAsync(500)
    expect(dispatch.mock.calls.map(([turn]) => turn.transcript)).toEqual(['最初の質問', '次の質問'])
    input.close()
  })

  it('remembers an identified delegation that arrives before its ASR', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.ingest(handoff('A'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(dispatch).not.toHaveBeenCalled()
    input.ingest(created('A', '要約しないで'))
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { id: 'A', role: 'user', transcript: '要約しないで' }, 'handoff',
    )
    input.close()
  })

  it('sends a short reply after local silence without a model boundary', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.setActivity(1, true)
    input.ingest(created('A', 'Aかな'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(dispatch).not.toHaveBeenCalled()
    input.setActivity(2, false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { id: 'A', role: 'user', transcript: 'Aかな' }, 'silence',
    )
    input.ingest(handoff('A'))
    input.ingest(done('A', 'Aかな'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(dispatch).toHaveBeenCalledOnce()
    input.close()
  })

  it('waits for delayed ASR, cancels on resumed speech, and ignores stale HTTP activity', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.setActivity(1, true)
    input.setActivity(2, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(dispatch).not.toHaveBeenCalled()
    input.ingest(created('A', 'ちょっと待って'))
    await vi.advanceTimersByTimeAsync(500)
    input.setActivity(3, true)
    input.setActivity(2, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(dispatch).not.toHaveBeenCalled()
    input.ingest({ type: 'turn.delta', turnId: 'A', delta: '、やっぱり B' })
    input.setActivity(4, false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(dispatch.mock.calls[0][0].transcript).toBe('ちょっと待って、やっぱり B')
    input.close()
  })

  it('sends new words in the same upstream turn once, including identical repetitions', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.setActivity(1, true)
    input.ingest(created('A', 'もう一度'))
    input.setActivity(2, false)
    await vi.advanceTimersByTimeAsync(1500)
    input.setActivity(3, true)
    input.ingest({ type: 'input_transcript.added', item: { text: 'もう一度' } })
    input.ingest({ type: 'turn.delta', turnId: 'A', delta: 'もう一度' })
    input.setActivity(4, false)
    await vi.advanceTimersByTimeAsync(1500)
    input.ingest(done('A', 'もう一度もう一度'))
    expect(dispatch.mock.calls).toEqual([
      [{ id: 'A', role: 'user', transcript: 'もう一度' }, 'silence'],
      [{ id: 'A:part-2', role: 'user', transcript: 'もう一度' }, 'silence'],
    ])
    input.close()
  })

  it('does not replay a final correction after sending raw ASR', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.ingest(created('A', 'いったん、確認して'))
    input.ingest(handoff('A'))
    await vi.advanceTimersByTimeAsync(750)
    input.ingest(done('A', '一旦確認して。'))
    expect(dispatch).toHaveBeenCalledOnce()
    input.close()
  })

  it('does not split ASR fragments arriving a second apart after microphone silence', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.setActivity(1, true)
    input.setActivity(2, false)
    input.ingest(created('A', '今'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatch).not.toHaveBeenCalled()
    input.ingest({ type: 'turn.delta', turnId: 'A', delta: 'すぐ確認して' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(dispatch.mock.calls.map(([turn]) => turn.transcript)).toEqual(['今すぐ確認して'])
    input.close()
  })

  it('preserves a late raw tail and cancels all pending work on close', async () => {
    const dispatch = vi.fn()
    const input = new LiveInputBuffer(dispatch)
    input.ingest(created('A', '確認して'))
    input.ingest(handoff('A'))
    await vi.advanceTimersByTimeAsync(750)
    input.ingest({ type: 'turn.delta', turnId: 'A', delta: '。変更はしないで' })
    input.ingest(done('A', '確認して。変更はしないで'))
    expect(dispatch.mock.calls.map(([turn]) => turn.transcript)).toEqual(['確認して', '。変更はしないで'])
    input.ingest(created('B', '送らない'))
    input.ingest(handoff('B'))
    input.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
