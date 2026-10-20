import type { LiveUiEvent } from '../events.js'
import {
  LIVE_CALLS_PATH,
  LIVE_EVENTS_PATH,
  LIVE_STATUS_PATH,
  LIVE_STOP_PATH,
} from '../ids.js'
import { isLiveFailureKind, type LiveFailureKind } from '../kinds.js'
import type { LiveServerEvent } from '../protocol.js'
import type { LiveVoice } from '../voices.js'

export type { LiveUiEvent }

export interface LiveStatus {
  microphone?: 'missing-audio-entitlement' | 'unknown'
  ready: boolean
  source: 'dsh-oauth-login' | 'dsh-llm' | 'codex-cli' | 'none'
  expiresAt?: number
  accountHint?: string
  expired?: boolean
  voices: readonly { value: LiveVoice; label: string }[]
  defaultVoice: LiveVoice
}

export interface LiveCallResponse {
  callToken: string
  callId: string
  answer: string
  voice: LiveVoice
}

export class LiveCallError extends Error {
  readonly kind: LiveFailureKind
  readonly upstreamStatus?: number

  constructor(message: string, kind: LiveFailureKind = 'unknown', upstreamStatus?: number) {
    super(message)
    this.name = 'LiveCallError'
    this.kind = kind
    this.upstreamStatus = upstreamStatus
  }
}

function liveErrorFromBody(parsed: unknown, status: number, fallback: string): LiveCallError {
  if (typeof parsed !== 'object' || parsed === null) {
    return new LiveCallError(fallback, status === 401 ? 'auth' : 'unknown', status)
  }
  const record = parsed as { error?: unknown; kind?: unknown; upstreamStatus?: unknown }
  const message = typeof record.error === 'string' && record.error.length > 0 ? record.error : fallback
  const kind = typeof record.kind === 'string' && isLiveFailureKind(record.kind)
    ? record.kind
    : status === 401 ? 'auth'
      : status === 403 ? 'forbidden'
        : status === 429 ? 'quota'
          : status === 409 ? 'session'
            : 'unknown'
  const upstream = typeof record.upstreamStatus === 'number' ? record.upstreamStatus : status
  return new LiveCallError(message, kind, upstream)
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
  if (!response.ok) {
    throw liveErrorFromBody(parsed, response.status, `Live voice request failed (${response.status})`)
  }
  return parsed as T
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  return readJson<LiveStatus>(await fetch(LIVE_STATUS_PATH))
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: abort.signal, credentials: 'same-origin' })
  } catch (error) {
    if (abort.signal.aborted) {
      throw new LiveCallError(
        `Live voice request timed out after ${Math.round(timeoutMs / 1000)}s`,
        'network',
      )
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export async function startLiveCall(input: {
  sessionId: string
  sdp: string
  voice: LiveVoice
}): Promise<LiveCallResponse> {
  return readJson<LiveCallResponse>(await fetchWithTimeout(LIVE_CALLS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId, sdp: input.sdp, voice: input.voice }),
  }, 40_000))
}

export async function stopLiveCall(callToken: string): Promise<void> {
  await readJson(await fetch(LIVE_STOP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callToken }),
  }))
}

export function subscribeLiveEvents(
  callToken: string,
  onEvent: (event: LiveUiEvent) => void,
): () => void {
  const source = new EventSource(`${LIVE_EVENTS_PATH}?call=${encodeURIComponent(callToken)}`)
  let terminalReported = false
  const handle = (message: Event): void => {
    if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return
    try {
      onEvent(JSON.parse(message.data) as LiveUiEvent)
    } catch {
      // Ignore a malformed frame; the next event still updates the UI.
    }
  }
  const handleSourceError = (event: Event): void => {
    if (event instanceof MessageEvent) {
      handle(event)
      return
    }
    if (terminalReported || source.readyState !== EventSource.CLOSED) return
    terminalReported = true
    source.close()
    onEvent({
      type: 'error',
      message: 'Live voice call ended or was replaced. Try again.',
      kind: 'network',
    })
  }
  source.addEventListener('phase', handle)
  source.addEventListener('ready', handle)
  source.addEventListener('playback', handle)
  source.addEventListener('transcript', handle)
  source.addEventListener('task-receipt', handle)
  source.addEventListener('usage', handle)
  source.addEventListener('error', handleSourceError)
  source.addEventListener('closed', handle)
  return () => { source.close() }
}

export type { LiveServerEvent }
