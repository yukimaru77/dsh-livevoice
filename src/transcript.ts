import type { LiveServerEvent } from './protocol.js'

export interface LiveTranscript {
  role: 'user' | 'assistant'
  text: string
  turn: number
  final: boolean
}

export interface RoleTranscript {
  text: string
  turn: number
  final: boolean
}

export interface TranscriptState {
  user: RoleTranscript
  assistant: RoleTranscript
  /** Codex turn id -> role, so a late `turn.delta` lands on the turn it names. */
  turnRoles?: Readonly<Record<string, LiveTranscript['role']>>
}

export interface TranscriptUpdate {
  state: TranscriptState
  /** Absent when only bookkeeping (turn ids) changed. */
  emit?: LiveTranscript
  present?: LiveTranscript
}

const emptyRole = (): RoleTranscript => ({ text: '', turn: 0, final: true })

export function emptyTranscriptState(): TranscriptState {
  return { user: emptyRole(), assistant: emptyRole() }
}

export function ingestLiveEvent(
  state: TranscriptState,
  event: LiveServerEvent,
): TranscriptUpdate | TranscriptUpdate[] | null {
  switch (event.type) {
    case 'input_transcript.added':
      // Codex already answering means the user turn was closed; a bare ASR
      // fragment now is that turn's tail (its turn.done carries the full
      // text). A real barge-in opens a new user turn via turn.created.
      if (state.user.final && state.user.text && !state.assistant.final) return null
      return applyAdd(state, 'user', event.item.text)
    case 'output_transcript.added': {
      const closed = closeOpenUser(state)
      const next = applyAdd(closed?.state ?? state, 'assistant', event.item.text)
      if (closed && next) return [closed, next]
      return next ?? closed
    }
    case 'turn.created': {
      const tracked = rememberTurn(state, event.turn.id, event.turn.role)
      const closed = event.turn.role === 'assistant' ? closeOpenUser(tracked) : null
      const base = closed?.state ?? tracked
      const next = applyAdd(base, event.turn.role, event.turn.transcript)
      if (closed && next) return [closed, next]
      return next ?? closed ?? (tracked === state ? null : { state: tracked })
    }
    case 'turn.delta': {
      const known = event.turnId === undefined ? undefined : state.turnRoles?.[event.turnId]
      // A delta for a turn that is already closed (Codex started speaking
      // before the user turn's last words arrived) belongs to that turn;
      // its turn.done carries the full text, so never graft it onto the
      // other role.
      if (known !== undefined && state[known].final) return null
      return applyAdd(state, known ?? openRole(state), event.delta)
    }
    case 'turn.done': {
      const update = applyFinish(state, event.turn.role, event.turn.transcript)
      return update === null ? null : { ...update, present: update.emit }
    }
    default:
      return null
  }
}

function rememberTurn(
  state: TranscriptState,
  turnId: string | undefined,
  role: LiveTranscript['role'],
): TranscriptState {
  if (turnId === undefined || state.turnRoles?.[turnId] === role) return state
  // Only recent turns matter; keep the map from growing over a long call.
  const recent = Object.entries(state.turnRoles ?? {}).slice(-15)
  return { ...state, turnRoles: { ...Object.fromEntries(recent), [turnId]: role } }
}

/**
 * Codex fragments carry their own leading whitespace (" you", ",", "? Please");
 * keep it so punctuation does not grow a space and CJK stays unspaced.
 */
function joinFragment(current: string, raw: string): string {
  const fragment = raw.trimEnd()
  const glued = /^\s/u.test(fragment) ? `${current} ${fragment.trimStart()}` : `${current}${fragment}`
  return glued.replaceAll(/\s+/g, ' ').trim()
}

function openRole(state: TranscriptState): LiveTranscript['role'] {
  if (!state.user.final) return 'user'
  if (!state.assistant.final) return 'assistant'
  return 'user'
}

function closeOpenUser(state: TranscriptState): TranscriptUpdate | null {
  if (state.user.final || !state.user.text) return null
  return applyFinish(state, 'user', state.user.text)
}

function applyAdd(
  state: TranscriptState,
  role: LiveTranscript['role'],
  text: string,
): TranscriptUpdate | null {
  const normalized = text.trim()
  if (!normalized) return null
  const current = state[role]
  let turn = current.turn
  let nextText: string
  if (!current.text) {
    turn += 1
    nextText = normalized
  } else if (current.final) {
    if (normalized === current.text || current.text.endsWith(normalized)) return null
    turn += 1
    nextText = normalized
  } else if (normalized.startsWith(current.text)) {
    nextText = normalized
  } else if (current.text.endsWith(normalized) || current.text.startsWith(normalized)) {
    // Already have these words: a repeated fragment, or a cumulative
    // turn.created snapshot that lags the fragments assembled so far.
    nextText = current.text
  } else {
    nextText = joinFragment(current.text, text)
  }
  const bucket = { text: nextText, turn, final: false }
  const emit: LiveTranscript = { role, text: nextText, turn, final: false }
  return { state: { ...state, [role]: bucket }, emit }
}

function applyFinish(
  state: TranscriptState,
  role: LiveTranscript['role'],
  text: string,
): TranscriptUpdate | null {
  const current = state[role]
  let turn = current.turn
  if (!current.text) turn += 1
  else if (current.final && text.trim() !== current.text) turn += 1
  const trimmed = text.trim()
  if (!trimmed && !current.text) return null
  const nextText = !current.final && current.text.startsWith(trimmed) && current.text.length > trimmed.length
    ? current.text
    : trimmed || current.text
  const bucket = { text: nextText, turn, final: true }
  const emit: LiveTranscript = { role, text: nextText, turn, final: true }
  return { state: { ...state, [role]: bucket }, emit }
}
