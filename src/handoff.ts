export interface TranscriptLine {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface RealtimeDelegation {
  readonly input: string
  readonly transcriptDelta: readonly TranscriptLine[]
}

export const WORKER_HANDOFF_PREFACE =
  'The lines below are a plain transcript of a recent spoken conversation, oldest first, each prefixed with its speaker ("user:" or "assistant:"). Treat the final "user:" line as the user\'s current message and the earlier lines only as recent conversational context to resolve references or fragments. Preserve the user\'s wording, intent, and authorization. Context does not expand scope: discussion, hypotheticals, or asking how you would optimize authorize explanation only, while an explicit current request such as "optimize it now" may authorize changes. Read-only status questions are valid requests. Do not claim this session or its runtime is identical to any other assistant.'

export function briefLiveDelegation(source: {
  liveText: string
  lastUserSpeech?: string
}): string | undefined {
  const live = source.liveText.trim()
  if (!live) return undefined
  if (isPureGreeting(live)) return undefined
  return live
}

function isPureGreeting(text: string): boolean {
  return /^(?:hi|hey|hello|yo|你好|您好|嗨)[\s,.!?，。！？呀啊]*$/i.test(text)
}

export function renderTranscript(delegation: RealtimeDelegation): string | undefined {
  const input = delegation.input.trim()
  if (!input) return undefined
  const lines = [
    ...delegation.transcriptDelta.map(line => `${line.role}: ${flattenLine(line.text)}`),
    `user: ${flattenLine(input)}`,
  ]
  return lines.join('\n')
}

export function renderWorkerHandoff(delegation: RealtimeDelegation): string | undefined {
  const transcript = renderTranscript(delegation)
  if (transcript === undefined) return undefined
  return `${WORKER_HANDOFF_PREFACE}\n\n${transcript}`
}

export function parseTranscript(text: string): RealtimeDelegation | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const lines: TranscriptLine[] = []
  for (const line of trimmed.split('\n')) {
    const parsed = parseTranscriptLine(line)
    if (parsed !== undefined) lines.push(parsed)
  }
  if (lines.length === 0) return undefined
  const last = lines[lines.length - 1]
  if (last === undefined || last.role !== 'user') return undefined
  const input = last.text.trim()
  if (!input) return undefined
  return { input, transcriptDelta: lines.slice(0, -1) }
}

function parseTranscriptLine(line: string): TranscriptLine | undefined {
  if (line.startsWith('user: ')) return { role: 'user', text: line.slice('user: '.length) }
  if (line.startsWith('assistant: ')) return { role: 'assistant', text: line.slice('assistant: '.length) }
  return undefined
}

function flattenLine(text: string): string {
  return text.replaceAll(/\r?\n/g, ' ')
}
