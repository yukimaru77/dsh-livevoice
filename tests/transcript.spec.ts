import { describe, expect, it } from 'vitest'
import { parseLiveServerEvent } from '../src/protocol.ts'
import { emptyTranscriptState, ingestLiveEvent, type TranscriptState, type TranscriptUpdate } from '../src/transcript.ts'

function ingest(
  state: TranscriptState,
  payload: unknown,
): { state: TranscriptState; finals: string[] } {
  const event = parseLiveServerEvent(payload)
  if (event === null) throw new Error('expected a live event')
  const result = ingestLiveEvent(state, event)
  if (result === null) return { state, finals: [] }
  const updates: TranscriptUpdate[] = Array.isArray(result) ? result : [result]
  return {
    state: updates.at(-1)?.state ?? state,
    finals: updates.flatMap(update => update.present ? [`${update.present.role}:${update.present.text}`] : []),
  }
}

describe('live transcript assembly', () => {
  it('does not finalize on turn.created so later words stay on the same utterance', () => {
    let state = emptyTranscriptState()
    const finals: string[] = []
    const steps = [
      { type: 'input_transcript.added', item: { text: ' Yeah' } },
      {
        type: 'turn.created',
        turn: { id: 'turn_1', role: 'user', transcript: ' Yeah', start_ms: 1000, end_ms: 1200 },
      },
      { type: 'turn.delta', delta: ' Yo', turn_id: 'turn_1' },
      { type: 'input_transcript.added', item: { text: ' 23号' } },
    ]
    for (const payload of steps) {
      const next = ingest(state, payload)
      state = next.state
      finals.push(...next.finals)
    }

    expect(finals, 'turn.created must not present the first word as a finished utterance')
      .toEqual([])
    expect(state.user.final).toBe(false)
    expect(state.user.text).toBe('Yeah Yo 23号')
  })

  it('finalizes the user utterance when Codex starts speaking', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'input_transcript.added', item: { text: '周日哪里吃' } }).state
    state = ingest(state, {
      type: 'turn.created',
      turn: { role: 'user', transcript: '周日哪里吃' },
    }).state
    const after = ingest(state, { type: 'output_transcript.added', item: { text: '你想去哪家？' } })

    expect(after.finals, 'assistant speech must not present the user utterance; only turn.done does')
      .toEqual([])
    expect(after.state.user.final).toBe(true)
    expect(after.state.user.text).toBe('周日哪里吃')
    expect(after.state.assistant.text).toBe('你想去哪家？')
    expect(after.state.assistant.final).toBe(false)
  })

  it('still honors an explicit turn.done', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'input_transcript.added', item: { text: '有没有结果' } }).state
    const after = ingest(state, {
      type: 'turn.done',
      turn: { role: 'user', transcript: '有没有结果' },
    })
    expect(after.finals).toEqual(['user:有没有结果'])
    expect(after.state.user.final).toBe(true)
  })

  // Captured from a gpt-live-1-codex call (2026-10-19): Codex starts speaking
  // before the user turn's last delta arrives, and sends both *_transcript.added
  // fragments and a cumulative turn.created snapshot for the assistant.
  it('keeps a late user delta off the assistant line and does not double the reply', () => {
    let state = emptyTranscriptState()
    const finals: string[] = []
    const steps = [
      { type: 'input_transcript.added', item: { text: 'Hello. Can' } },
      { type: 'turn.created', turn: { id: 'turn_u', role: 'user', transcript: 'Hello. Can' } },
      { type: 'input_transcript.added', item: { text: ' you' } },
      { type: 'turn.delta', delta: ' you', turn_id: 'turn_u' },
      { type: 'input_transcript.added', item: { text: ' hear me? Please reply with one short' } },
      { type: 'turn.delta', delta: ' hear me? Please reply with one short', turn_id: 'turn_u' },
      { type: 'output_transcript.added', item: { text: ' Yes' } },
      { type: 'input_transcript.added', item: { text: ' sentence.' } },
      { type: 'turn.delta', delta: ' sentence.', turn_id: 'turn_u' },
      { type: 'output_transcript.added', item: { text: ',' } },
      { type: 'output_transcript.added', item: { text: ' I can' } },
      { type: 'output_transcript.added', item: { text: ' hear' } },
      { type: 'output_transcript.added', item: { text: ' you' } },
      {
        type: 'turn.done',
        turn: { id: 'turn_u', role: 'user', transcript: 'Hello. Can you hear me? Please reply with one short sentence.' },
      },
      { type: 'turn.created', turn: { id: 'turn_a', role: 'assistant', transcript: ' Yes, I can hear' } },
      { type: 'turn.delta', delta: ' you', turn_id: 'turn_a' },
      { type: 'output_transcript.added', item: { text: ' clearly' } },
      { type: 'turn.delta', delta: ' clearly', turn_id: 'turn_a' },
      { type: 'output_transcript.added', item: { text: '.' } },
      { type: 'turn.delta', delta: '.', turn_id: 'turn_a' },
    ]
    const assistantLines: string[] = []
    for (const payload of steps) {
      const next = ingest(state, payload)
      state = next.state
      finals.push(...next.finals)
      if (state.assistant.text) assistantLines.push(state.assistant.text)
    }
    expect(assistantLines.every(line => !line.includes('sentence'))).toBe(true)
    expect(state.user.text, 'the late ASR tail must not open a new user turn')
      .toBe('Hello. Can you hear me? Please reply with one short sentence.')
    expect(state.assistant.text).toBe('Yes, I can hear you clearly.')
    expect(finals).toEqual(['user:Hello. Can you hear me? Please reply with one short sentence.'])
    const done = ingest(state, {
      type: 'turn.done',
      turn: { id: 'turn_a', role: 'assistant', transcript: ' Yes, I can hear you clearly.' },
    })
    expect(done.finals).toEqual(['assistant:Yes, I can hear you clearly.'])
  })

  it('glues CJK fragments without inventing spaces', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'output_transcript.added', item: { text: '好的' } }).state
    state = ingest(state, { type: 'output_transcript.added', item: { text: '，马上' } }).state
    expect(state.assistant.text).toBe('好的，马上')
  })

  it('opens a new user turn on barge-in while Codex is still speaking', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'input_transcript.added', item: { text: 'hi' } }).state
    state = ingest(state, { type: 'output_transcript.added', item: { text: 'Hello there' } }).state
    state = ingest(state, { type: 'turn.created', turn: { id: 'turn_b', role: 'user', transcript: 'wait' } }).state
    expect(state.user).toMatchObject({ text: 'wait', final: false })
    state = ingest(state, { type: 'input_transcript.added', item: { text: ' stop' } }).state
    expect(state.user.text).toBe('wait stop')
  })

  it('opens an empty new user turn during assistant speech and accepts its fragments', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'turn.created', turn: { id: 'u1', role: 'user', transcript: 'Aかな' } }).state
    state = ingest(state, { type: 'turn.done', turn: { id: 'u1', role: 'user', transcript: 'Aかな' } }).state
    state = ingest(state, { type: 'output_transcript.added', item: { text: '回答します' } }).state
    state = ingest(state, { type: 'turn.created', turn: { id: 'u2', role: 'user', transcript: '' } }).state
    expect(state.user).toMatchObject({ text: '', turn: 2, final: false })

    state = ingest(state, { type: 'input_transcript.added', item: { text: '次は' } }).state
    state = ingest(state, { type: 'turn.delta', turn_id: 'u2', delta: 'Bで' }).state
    expect(state.user).toMatchObject({ text: '次はBで', turn: 2, final: false })
    state = ingest(state, { type: 'turn.delta', turn_id: 'u1', delta: '古い発話の末尾' }).state
    expect(state.user.text).toBe('次はBで')
    expect(state.assistant.text).toBe('回答します')

    const done = ingest(state, { type: 'turn.done', turn: { id: 'u2', role: 'user', transcript: '次はBで' } })
    expect(done.state.user).toMatchObject({ text: '次はBで', turn: 2, final: true })
    expect(done.finals).toEqual(['user:次はBで'])
  })

  it('preserves ASR that arrives before an empty created snapshot and ignores duplicate starts', () => {
    let state = emptyTranscriptState()
    state = ingest(state, { type: 'input_transcript.added', item: { text: '次は' } }).state
    const created = { type: 'turn.created', turn: { id: 'u1', role: 'user', transcript: '' } }
    state = ingest(state, created).state
    expect(state.user).toMatchObject({ text: '次は', turn: 1, final: false })
    state = ingest(state, { type: 'turn.delta', turn_id: 'u1', delta: 'Bで' }).state
    state = ingest(state, created).state
    expect(state.user).toMatchObject({ text: '次はBで', turn: 1, final: false })

    state = ingest(state, { type: 'turn.done', turn: { id: 'u1', role: 'user', transcript: '次はBで' } }).state
    state = ingest(state, created).state
    state = ingest(state, { type: 'turn.created', turn: { id: 'u1', role: 'user', transcript: '次は' } }).state
    expect(state.user).toMatchObject({ text: '次はBで', turn: 1, final: true })

    state = ingest(state, { type: 'input_transcript.added', item: { text: 'その次は' } }).state
    state = ingest(state, { type: 'turn.created', turn: { id: 'u2', role: 'user', transcript: '' } }).state
    expect(state.user).toMatchObject({ text: 'その次は', turn: 2, final: false })
  })

  it('keeps the same words in different upstream turns as distinct utterances', () => {
    let state = emptyTranscriptState()
    for (const [index, id] of ['u1', 'u2'].entries()) {
      state = ingest(state, { type: 'turn.created', turn: { id, role: 'user', transcript: '' } }).state
      state = ingest(state, { type: 'input_transcript.added', item: { text: 'もう一度' } }).state
      const done = ingest(state, { type: 'turn.done', turn: { id, role: 'user', transcript: 'もう一度' } })
      state = done.state
      expect(state.user).toMatchObject({ text: 'もう一度', turn: index + 1, final: true })
      expect(done.finals).toEqual(['user:もう一度'])
    }
  })
})
