export const LIVE_MODEL = 'gpt-live-1-codex' as const

/** WebRTC data channel Codex and omp wait on before the live call is up. */
export const LIVE_EVENTS_CHANNEL = 'oai-events' as const

export const CONTEXT_CHUNK_BYTES = 500

export type LiveContextChannel = 'speakable' | 'commentary'

export type LiveInputTextContent = { type: 'input_text'; text: string }

export type LiveSessionPayload = {
  model: typeof LIVE_MODEL
  instructions: string
  audio: { output: { voice: string } }
  delegation: { type: 'client'; ack_filler: false }
}

export type LiveClientMessage =
  | {
    type: 'delegation.context.append'
    delegation_item_id: string
    channel?: LiveContextChannel
    content: LiveInputTextContent[]
  }
  | {
    type: 'session.context.append'
    channel?: LiveContextChannel
    content: LiveInputTextContent[]
  }
  | { type: 'session.close' }

export type LiveUsageSource = 'session.usage.updated' | 'rate_limits.updated'

export type LiveUsageMetric = {
  readonly name: string
  readonly value: number | string
}

export type LiveServerEvent =
  | {
    type: 'session.started' | 'session.updated'
    session: { id: string; instructions?: string }
  }
  | { type: 'output_audio.delta'; audio: string }
  | { type: 'input_transcript.added' | 'output_transcript.added'; item: { text: string } }
  | { type: 'turn.created'; turn: LiveTurn }
  | { type: 'turn.delta'; delta: string; turnId?: string }
  | { type: 'turn.done'; turn: LiveTurn }
  | {
    type: 'delegation.created'
    item: {
      type: 'delegation'
      target: 'client'
      id: string
      content: LiveInputTextContent[]
    }
  }
  | { type: LiveUsageSource; metrics: LiveUsageMetric[] }
  | { type: 'error'; message: string }
  | { type: 'unknown'; wireType: string }

/** `id` is Codex's turn id; `turn.delta` names it as `turn_id`. */
export type LiveTurn = { role: 'user' | 'assistant'; transcript: string; id?: string }

export type LivePhase = 'connecting' | 'listening' | 'working' | 'speaking' | 'muted' | 'error'

export function isLiveSessionProof(event: LiveServerEvent): boolean {
  switch (event.type) {
    case 'session.started':
    case 'session.updated':
    case 'input_transcript.added':
    case 'output_transcript.added':
    case 'turn.created':
    case 'turn.delta':
    case 'turn.done':
    case 'delegation.created':
      return true
    default:
      return false
  }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePayload(payload: unknown): UnknownRecord | null {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      return null
    }
  }
  return isRecord(parsed) ? parsed : null
}

function parseSessionEvent(
  type: 'session.started' | 'session.updated',
  payload: UnknownRecord,
): LiveServerEvent | null {
  const session = payload.session
  if (isRecord(session) && typeof session.id === 'string') {
    if (typeof session.instructions === 'string') {
      return { type, session: { id: session.id, instructions: session.instructions } }
    }
    return { type, session: { id: session.id } }
  }
  return type === 'session.started' ? { type, session: { id: '' } } : null
}

function parseTranscriptAddedEvent(
  type: 'input_transcript.added' | 'output_transcript.added',
  payload: UnknownRecord,
): LiveServerEvent | null {
  const item = payload.item
  if (!isRecord(item) || typeof item.text !== 'string') return null
  return { type, item: { text: item.text } }
}

function parseTurnRole(payload: UnknownRecord): LiveTurn | null {
  const turn = payload.turn
  if (!isRecord(turn) || (turn.role !== 'user' && turn.role !== 'assistant')) return null
  if (typeof turn.transcript !== 'string') return null
  return typeof turn.id === 'string' && turn.id.length > 0
    ? { role: turn.role, transcript: turn.transcript, id: turn.id }
    : { role: turn.role, transcript: turn.transcript }
}

function parseTurnCreatedEvent(payload: UnknownRecord): LiveServerEvent | null {
  const turn = parseTurnRole(payload)
  return turn === null ? null : { type: 'turn.created', turn }
}

function parseTurnDeltaEvent(payload: UnknownRecord): LiveServerEvent | null {
  if (typeof payload.delta !== 'string') return null
  return typeof payload.turn_id === 'string' && payload.turn_id.length > 0
    ? { type: 'turn.delta', delta: payload.delta, turnId: payload.turn_id }
    : { type: 'turn.delta', delta: payload.delta }
}

function parseTurnDoneEvent(payload: UnknownRecord): LiveServerEvent | null {
  const turn = parseTurnRole(payload)
  return turn === null ? null : { type: 'turn.done', turn }
}

function parseDelegationCreatedEvent(payload: UnknownRecord): LiveServerEvent | null {
  const item = payload.item
  if (!isRecord(item) || item.type !== 'delegation' || item.target !== 'client' || typeof item.id !== 'string') {
    return null
  }
  if (!Array.isArray(item.content)) return null
  const content: LiveInputTextContent[] = []
  for (const candidate of item.content) {
    if (!isRecord(candidate) || candidate.type !== 'input_text' || typeof candidate.text !== 'string') continue
    content.push({ type: 'input_text', text: candidate.text })
  }
  return {
    type: 'delegation.created',
    item: { type: 'delegation', target: 'client', id: item.id, content },
  }
}

function stringifyErrorValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === undefined) return null
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return String(value)
  }
}

function parseErrorEvent(payload: UnknownRecord): LiveServerEvent | null {
  if (typeof payload.message === 'string') return { type: 'error', message: payload.message }
  const error = payload.error
  if (isRecord(error) && typeof error.message === 'string') {
    return { type: 'error', message: error.message }
  }
  const message = stringifyErrorValue(error)
  return message === null ? null : { type: 'error', message }
}

function parseUsageValue(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return undefined
}

function addUsageMetric(
  metrics: LiveUsageMetric[],
  seen: Set<string>,
  name: string,
  value: unknown,
): void {
  const parsed = parseUsageValue(value)
  if (parsed === undefined || seen.has(name)) return
  seen.add(name)
  metrics.push({ name, value: parsed })
}

function addUsageRecord(
  metrics: LiveUsageMetric[],
  seen: Set<string>,
  record: UnknownRecord,
  prefix?: string,
): void {
  for (const [name, value] of Object.entries(record)) {
    const key = prefix === undefined ? name : `${prefix}.${name}`
    if (isRecord(value)) {
      for (const [nestedName, nestedValue] of Object.entries(value)) {
        addUsageMetric(metrics, seen, `${key}.${nestedName}`, nestedValue)
      }
      continue
    }
    addUsageMetric(metrics, seen, key, value)
  }
}

export function parseUsageMetrics(payload: UnknownRecord): LiveUsageMetric[] {
  const metrics: LiveUsageMetric[] = []
  const seen = new Set<string>()
  if (isRecord(payload.usage)) addUsageRecord(metrics, seen, payload.usage)
  if (isRecord(payload.session) && isRecord(payload.session.usage)) {
    addUsageRecord(metrics, seen, payload.session.usage)
  }
  for (const [name, value] of Object.entries(payload)) {
    if (name === 'type' || name === 'usage' || name === 'session' || name === 'event_id') continue
    addUsageMetric(metrics, seen, name, value)
  }
  return metrics
}

export function formatLiveUsageMetrics(metrics: readonly LiveUsageMetric[]): string {
  return metrics.map(metric => `${metric.name} ${metric.value}`).join(' · ')
}

export function parseLiveServerEvent(payload: unknown): LiveServerEvent | null {
  const parsed = parsePayload(payload)
  if (!parsed || typeof parsed.type !== 'string') return null

  switch (parsed.type) {
    case 'session.started':
    case 'session.updated':
      return parseSessionEvent(parsed.type, parsed)
    case 'output_audio.delta':
      return typeof parsed.audio === 'string' ? { type: parsed.type, audio: parsed.audio } : null
    case 'input_transcript.added':
    case 'output_transcript.added':
      return parseTranscriptAddedEvent(parsed.type, parsed)
    case 'turn.created':
      return parseTurnCreatedEvent(parsed)
    case 'turn.delta':
      return parseTurnDeltaEvent(parsed)
    case 'turn.done':
      return parseTurnDoneEvent(parsed)
    case 'delegation.created':
      return parseDelegationCreatedEvent(parsed)
    case 'session.usage.updated':
      return { type: 'session.usage.updated', metrics: parseUsageMetrics(parsed) }
    case 'rate_limits.updated':
      return { type: 'rate_limits.updated', metrics: parseUsageMetrics(parsed) }
    case 'error':
      return parseErrorEvent(parsed)
    default:
      return { type: 'unknown', wireType: parsed.type }
  }
}

export function buildLiveSessionPayload(instructions: string, voice: string): LiveSessionPayload {
  return {
    model: LIVE_MODEL,
    instructions,
    audio: { output: { voice } },
    delegation: { type: 'client', ack_filler: false },
  }
}

export function buildDelegationContextAppend(
  delegationItemId: string,
  text: string,
  channel?: LiveContextChannel,
): LiveClientMessage {
  return {
    type: 'delegation.context.append',
    delegation_item_id: delegationItemId,
    ...(channel === undefined ? {} : { channel }),
    content: [{ type: 'input_text', text }],
  }
}

export function buildSessionContextAppend(text: string, channel?: LiveContextChannel): LiveClientMessage {
  return {
    type: 'session.context.append',
    ...(channel === undefined ? {} : { channel }),
    content: [{ type: 'input_text', text }],
  }
}

export function buildSessionClose(): LiveClientMessage {
  return { type: 'session.close' }
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

export function chunkLiveContext(text: string): string[] {
  if (text.length === 0) return ['']

  const chunks: string[] = []
  let chunkStart = 0
  let chunkBytes = 0
  let index = 0
  while (index < text.length) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const characterLength = codePoint > 0xffff ? 2 : 1
    const characterBytes = utf8ByteLength(codePoint)
    if (chunkBytes + characterBytes > CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(chunkStart, index))
      chunkStart = index
      chunkBytes = 0
    }
    chunkBytes += characterBytes
    index += characterLength
  }
  chunks.push(text.slice(chunkStart))
  return chunks
}
