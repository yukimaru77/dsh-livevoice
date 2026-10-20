import type { MessageId } from '@deepseek-ai/dsh-llm'

type Entry = {
  liveId: string
  messageId: MessageId
  turn?: number
  replies: { seq: number; text: string }[]
  lastReply: number
}

/** Correlates inbox claims with replies, not with the latest question's wording. */
export class LiveDelegations {
  private readonly entries = new Map<string, Entry>()
  private readonly seenReplies = new Map<number, Set<number>>()
  private replyNumber = 0

  get active(): boolean { return this.entries.size > 0 }

  create(liveId: string, messageId: MessageId): void {
    if (!this.entries.has(liveId)) {
      this.entries.set(liveId, { liveId, messageId, replies: [], lastReply: 0 })
    }
  }

  claim(messageId: MessageId, turn: number): void {
    const entry = [...this.entries.values()].find(item => item.messageId === messageId)
    if (entry && entry.turn === undefined) entry.turn = turn
  }

  discard(messageId: MessageId): void {
    for (const entry of this.entries.values()) {
      if (entry.messageId === messageId) this.entries.delete(entry.liveId)
    }
  }

  private audience(turn: number): Entry[] {
    const claimed = [...this.entries.values()].filter(entry => entry.turn === turn)
    const unanswered = claimed.filter(entry => entry.lastReply === 0)
    if (unanswered.length) return unanswered
    const latest = Math.max(0, ...claimed.map(entry => entry.lastReply))
    return claimed.filter(entry => entry.lastReply === latest)
  }

  commentaryAudience(turn: number): string[] {
    return this.audience(turn).map(entry => entry.liveId)
  }

  reply(turn: number, seq: number, text: string): void {
    const audience = this.audience(turn)
    if (!text || !audience.length) return
    const seen = this.seenReplies.get(turn) ?? new Set<number>()
    if (seen.has(seq)) return
    seen.add(seq)
    this.seenReplies.set(turn, seen)
    const number = ++this.replyNumber
    for (const entry of audience) {
      entry.replies.push({ seq, text })
      entry.lastReply = number
    }
  }

  end(turn: number): { liveId: string; text: string; speechText: string }[] {
    const results: { liveId: string; text: string; speechText: string }[] = []
    const spoken = new Set<number>()
    const entries = [...this.entries.values()].filter(entry => entry.turn === turn)
      .sort((a, b) => (a.replies[0]?.seq ?? Infinity) - (b.replies[0]?.seq ?? Infinity))
    for (const entry of entries) {
      // Every request keeps its receipt, but a shared backend message is read
      // only once. Deduplicate event IDs, never equal text from distinct replies.
      const speech = entry.replies.filter(reply => {
        if (spoken.has(reply.seq)) return false
        spoken.add(reply.seq)
        return true
      })
      results.push({
        liveId: entry.liveId,
        text: entry.replies.map(reply => reply.text).join('\n\n'),
        speechText: speech.map(reply => reply.text).join('\n\n'),
      })
      this.entries.delete(entry.liveId)
    }
    this.seenReplies.delete(turn)
    return results
  }
}
