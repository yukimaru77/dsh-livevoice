export interface TranscriptLine {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface RealtimeDelegation {
  readonly input: string
  readonly transcriptDelta: readonly TranscriptLine[]
}

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

// The worker handoff is the plain transcript itself: no preface, legend, or
// framing text, so the backend sees exactly the same "user:"/"assistant:"
// lines a human would read, with no sign a live-voice relay is involved.
export const renderWorkerHandoff = renderTranscript

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
