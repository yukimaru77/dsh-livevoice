import { describe, expect, it } from 'vitest'
import { parseLiveCallId } from '../src/catalog.ts'
import {
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionClose,
  buildSessionContextAppend,
  CONTEXT_CHUNK_BYTES,
  chunkLiveContext,
  isLiveSessionProof,
  LIVE_EVENTS_CHANNEL,
  LIVE_MODEL,
  parseLiveServerEvent,
} from '../src/protocol.ts'

describe('Frameless Bidi server events', () => {
  it('parses a client delegation and keeps only input text content', () => {
    const event = parseLiveServerEvent(JSON.stringify({
      type: 'delegation.created',
      item: {
        type: 'delegation',
        target: 'client',
        id: 'delegation-7',
        content: [
          { type: 'input_text', text: 'Inspect the failing build. ' },
          { type: 'output_text', text: 'ignored' },
          { type: 'input_text', text: 'Repair the root cause.' },
        ],
      },
    }))
    expect(event).toEqual({
      type: 'delegation.created',
      item: {
        type: 'delegation',
        target: 'client',
        id: 'delegation-7',
        content: [
          { type: 'input_text', text: 'Inspect the failing build. ' },
          { type: 'input_text', text: 'Repair the root cause.' },
        ],
      },
    })
  })

  it('parses session.started with extra Codex fields', () => {
    expect(parseLiveServerEvent({
      type: 'session.started',
      session: { id: 'rtc_u23_EJ7jcHsbu6mfB8VBxhCXz', status: 'active', expires_at: 1788233872 },
    })).toEqual({
      type: 'session.started',
      session: { id: 'rtc_u23_EJ7jcHsbu6mfB8VBxhCXz' },
    })
  })

  it('parses a bare session.started as live-session proof', () => {
    const event = parseLiveServerEvent({ type: 'session.started' })
    expect(event).toEqual({ type: 'session.started', session: { id: '' } })
    if (event === null) throw new Error('expected session.started')
    expect(isLiveSessionProof(event)).toBe(true)
  })

  it('does not treat errors or usage events as live-session proof', () => {
    const error = parseLiveServerEvent({ type: 'error', message: 'nope' })
    const usage = parseLiveServerEvent({ type: 'session.usage.updated' })
    if (error === null || usage === null) throw new Error('expected parsed events')
    expect(isLiveSessionProof(error)).toBe(false)
    expect(isLiveSessionProof(usage)).toBe(false)
    expect(usage).toEqual({ type: 'session.usage.updated', metrics: [] })
  })

  it('keeps session.usage.updated fields as metrics without inventing remaining minutes', () => {
    expect(parseLiveServerEvent({
      type: 'session.usage.updated',
      usage: { input_tokens: 12, output_tokens: 4, audio: { seconds: 9 } },
    })).toEqual({
      type: 'session.usage.updated',
      metrics: [
        { name: 'input_tokens', value: 12 },
        { name: 'output_tokens', value: 4 },
        { name: 'audio.seconds', value: 9 },
      ],
    })
  })

  it('parses rate_limits.updated remaining as a raw metric', () => {
    expect(parseLiveServerEvent({ type: 'rate_limits.updated', remaining: 3 })).toEqual({
      type: 'rate_limits.updated',
      metrics: [{ name: 'remaining', value: 3 }],
    })
  })

  it('parses input and output transcript deltas', () => {
    expect(parseLiveServerEvent({ type: 'input_transcript.added', item: { text: 'What changed?' } })).toEqual({
      type: 'input_transcript.added',
      item: { text: 'What changed?' },
    })
    expect(parseLiveServerEvent({ type: 'output_transcript.added', item: { text: 'I will inspect it.' } })).toEqual({
      type: 'output_transcript.added',
      item: { text: 'I will inspect it.' },
    })
  })

  it('parses completed user and assistant turns', () => {
    expect(parseLiveServerEvent({ type: 'turn.done', turn: { role: 'user', transcript: 'Run the checks.' } }))
      .toEqual({ type: 'turn.done', turn: { role: 'user', transcript: 'Run the checks.' } })
    expect(parseLiveServerEvent({ type: 'turn.done', turn: { role: 'assistant', transcript: 'The checks pass.' } }))
      .toEqual({ type: 'turn.done', turn: { role: 'assistant', transcript: 'The checks pass.' } })
  })

  it('keeps Codex turn.created as the start of a turn, not the end', () => {
    expect(parseLiveServerEvent({
      type: 'turn.created',
      turn: {
        id: 'turn_EJ9XQNFB8yNZ4cdxujkMd',
        role: 'user',
        transcript: ' Yeah',
        start_ms: 1000,
        end_ms: 1200,
      },
    })).toEqual({
      type: 'turn.created',
      turn: { role: 'user', transcript: ' Yeah', id: 'turn_EJ9XQNFB8yNZ4cdxujkMd' },
    })
  })

  it('parses turn.delta fragments on the open turn', () => {
    expect(parseLiveServerEvent({
      type: 'turn.delta',
      delta: ' Yo',
      turn_id: 'turn_EJ9XQNFB8yNZ4cdxujkMd',
      start_ms: 111000,
      end_ms: 111200,
    })).toEqual({ type: 'turn.delta', delta: ' Yo', turnId: 'turn_EJ9XQNFB8yNZ4cdxujkMd' })
    expect(parseLiveServerEvent({ type: 'turn.delta', delta: ' Yo' })).toEqual({ type: 'turn.delta', delta: ' Yo' })
  })

  it('classifies unsupported events and rejects malformed known events', () => {
    expect(parseLiveServerEvent({ type: 'session.updated.unknown', remaining: 3 })).toEqual({
      type: 'unknown',
      wireType: 'session.updated.unknown',
    })
    expect(parseLiveServerEvent({ type: 'output_audio.delta', audio: 12 })).toBeNull()
    expect(parseLiveServerEvent({ type: 'turn.done', turn: { role: 'tool', transcript: 'no' } })).toBeNull()
    expect(parseLiveServerEvent('not json')).toBeNull()
  })
})

describe('Frameless Bidi client payloads', () => {
  it('builds the exact live call session JSON', () => {
    const payload = buildLiveSessionPayload('Be concise.', 'marin')
    expect(LIVE_MODEL).toBe('gpt-live-1-codex')
    expect(LIVE_EVENTS_CHANNEL).toBe('oai-events')
    expect(JSON.stringify(payload)).toBe(
      '{"model":"gpt-live-1-codex","instructions":"Be concise.","audio":{"output":{"voice":"marin"}},"delegation":{"type":"client","ack_filler":false}}',
    )
  })

  it('builds delegation and session close payloads', () => {
    expect(JSON.stringify(buildDelegationContextAppend('delegation-7', 'The tests now pass.', 'commentary')))
      .toBe('{"type":"delegation.context.append","delegation_item_id":"delegation-7","channel":"commentary","content":[{"type":"input_text","text":"The tests now pass."}]}')
    expect(buildSessionContextAppend('Still investigating.', 'speakable')).toEqual({
      type: 'session.context.append',
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'Still investigating.' }],
    })
    expect(buildSessionClose()).toEqual({ type: 'session.close' })
  })
})

describe('live helpers', () => {
  it('chunks UTF-8 safely', () => {
    const text = `${'a'.repeat(497)}🙂${'é漢🙂'.repeat(180)}`
    const chunks = chunkLiveContext(text)
    const encoder = new TextEncoder()
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).byteLength).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES)
    }
  })

  it('extracts rtc call ids from Location', () => {
    expect(parseLiveCallId('https://chatgpt.com/backend-api/codex/realtime/calls/rtc_abc-1?x=1')).toBe('rtc_abc-1')
    expect(parseLiveCallId('/not-a-call')).toBeUndefined()
  })
})
