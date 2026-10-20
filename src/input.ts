import type { LiveServerEvent, LiveTurn } from './protocol.js'

export type LiveInputSource = 'final' | 'handoff' | 'silence'

const SETTLE_MS = 750
// Without a model boundary, allow slower ASR fragments to finish arriving.
const SILENCE_SETTLE_MS = 1_500

interface InputTurn {
  id?: string
  text: string
  mirror: string
  sent: string
  parts: number
  created: boolean
  final: boolean
  handoff: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Keep raw ASR and completion signals separate: delegation text is never input. */
export class LiveInputBuffer {
  private readonly turns = new Map<string, InputTurn>()
  private readonly delegations = new Set<string>()
  private current: InputTurn | undefined
  private openRole: LiveTurn['role'] = 'user'
  private unkeyedHandoff = false
  private activitySequence = 0
  private speaking: boolean | undefined
  private closed = false

  constructor(private readonly dispatch: (turn: LiveTurn, source: LiveInputSource) => void) {}

  setActivity(sequence: number, speaking: boolean): void {
    if (this.closed || sequence <= this.activitySequence) return
    this.activitySequence = sequence
    this.speaking = speaking
    for (const turn of this.pending()) {
      if (speaking) this.clearTimer(turn)
      else this.schedule(turn)
    }
  }

  ingest(event: LiveServerEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'input_transcript.added': {
        if (!event.item.text) return
        this.openRole = 'user'
        const turn = this.current && !this.current.final ? this.current : this.open()
        turn.mirror += event.item.text
        this.schedule(turn)
        break
      }
      case 'turn.created': {
        this.openRole = event.turn.role
        if (event.turn.role !== 'user') break
        const turn = this.resolve(event.turn.id)
        if (turn.created || turn.final) break
        turn.created = true
        turn.text = event.turn.transcript || turn.mirror
        this.current = turn
        this.schedule(turn)
        break
      }
      case 'turn.delta': {
        if (event.turnId === undefined && this.openRole !== 'user') break
        const turn = event.turnId === undefined ? this.current : this.turns.get(event.turnId)
        if (!turn || turn.final) break
        // The other ASR stream mirrors these fragments; never concatenate both.
        turn.text += event.delta
        this.schedule(turn)
        break
      }
      case 'turn.done': {
        if (event.turn.role !== 'user') break
        // An unkeyed duplicate final is a replay until new speech opens a turn.
        if (event.turn.id === undefined && this.current?.final
          && this.current.text === event.turn.transcript) break
        const turn = this.resolve(event.turn.id)
        if (turn.final) break
        const final = event.turn.transcript
        // A late final may revise already-delivered ASR. Do not re-send the
        // request with different wording; keep any still-unsent raw tail.
        if (final.trim() && (!turn.sent || final.startsWith(turn.sent))) turn.text = final
        turn.final = true
        this.clearTimer(turn)
        this.send(turn, 'final')
        break
      }
      case 'delegation.created': {
        if (this.delegations.has(event.item.id)) break
        this.delegations.add(event.item.id)
        const id = event.item.userTurnId
        const turn = id === undefined ? this.current : this.turns.get(id) ?? this.open(id, false)
        if (!turn) {
          this.unkeyedHandoff = true
          break
        }
        if (turn.final) break
        turn.handoff = true
        this.schedule(turn)
        break
      }
    }
  }

  close(): void {
    this.closed = true
    for (const turn of this.pending()) this.clearTimer(turn)
  }

  private resolve(id?: string): InputTurn {
    if (id !== undefined) {
      const known = this.turns.get(id)
      if (known) {
        // A delegation can create a placeholder before unkeyed ASR arrives.
        // Attach that ASR (and any delivery cursor) when its real ID appears.
        const pending = this.current
        if (!known.created && !known.final && pending && pending.id === undefined && !pending.final) {
          this.clearTimer(pending)
          known.text = pending.text
          known.mirror = pending.mirror
          known.sent = pending.sent
          known.parts = pending.parts
          known.handoff ||= pending.handoff
          this.current = known
        }
        return known
      }
      if (this.current && this.current.id === undefined && !this.current.final) {
        this.current.id = id
        this.turns.set(id, this.current)
        return this.current
      }
      return this.open(id)
    }
    return this.current && !this.current.final ? this.current : this.open()
  }

  private open(id?: string, current = true): InputTurn {
    const turn: InputTurn = {
      id, text: '', mirror: '', sent: '', parts: 0,
      created: false, final: false, handoff: this.unkeyedHandoff,
    }
    this.unkeyedHandoff = false
    if (id !== undefined) this.turns.set(id, turn)
    if (current) this.current = turn
    return turn
  }

  private pending(): Set<InputTurn> {
    return new Set([...this.turns.values(), ...(this.current ? [this.current] : [])])
  }

  private clearTimer(turn: InputTurn): void {
    clearTimeout(turn.timer)
    turn.timer = undefined
  }

  private schedule(turn: InputTurn): void {
    this.clearTimer(turn)
    if (turn.final || this.speaking === true || (!turn.handoff && this.speaking !== false)) return
    turn.timer = setTimeout(() => {
      turn.timer = undefined
      if (this.closed) return
      this.send(turn, turn.handoff ? 'handoff' : 'silence')
    }, turn.handoff ? SETTLE_MS : SILENCE_SETTLE_MS)
  }

  private send(turn: InputTurn, source: LiveInputSource): void {
    const text = turn.text.trim() ? turn.text : turn.mirror
    // A local silence can split one upstream turn into multiple utterances.
    // Send only its new suffix, so neither the continuation nor repeated words
    // are lost when a delegation or final eventually arrives.
    if (!text.startsWith(turn.sent)) return
    const input = text.slice(turn.sent.length)
    if (!input.trim()) return
    turn.sent = text
    turn.parts += 1
    const id = turn.id === undefined ? undefined
      : turn.parts === 1 ? turn.id : `${turn.id}:part-${turn.parts}`
    this.dispatch({ role: 'user', transcript: input, ...(id ? { id } : {}) }, source)
  }
}
