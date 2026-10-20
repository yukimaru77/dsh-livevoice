import { MicrophoneAccessError } from './microphone-error.js'
import { DEFAULT_LIVE_VOICE, type LiveVoice, resolveLiveVoice } from '../voices.js'
import { isLiveFailureKind, type LiveFailureKind } from '../kinds.js'
import type { LiveUsageMetric, LiveUsageSource } from '../protocol.js'
import {
  fetchLiveStatus,
  LiveCallError,
  sendLiveInputActivity,
  startLiveCall,
  stopLiveCall,
  subscribeLiveEvents,
  type LiveStatus,
  type LiveUiEvent,
} from './api.js'
import { createLevelMonitor, InputActivityDetector } from './levels.js'
import { unlockPlayback, type PreparedPlayback } from './playback.js'
import { acceptLiveAnswer, createLivePeer, type LivePeer } from './webrtc.js'
import { parseLiveServerEvent, type LivePhase } from '../protocol.js'
import {
  mergeLiveTaskReceipt,
  stopTrackingLiveTaskReceipts,
  type LiveTaskReceipt,
} from '../receipts.js'

const VOICE_KEY = 'dsh-livevoice.voice'
const voiceHub = new Set<() => void>()

export function storedLiveVoice(): LiveVoice {
  return loadVoice()
}

export function subscribeStoredVoice(listener: () => void): () => void {
  voiceHub.add(listener)
  return () => { voiceHub.delete(listener) }
}

export function chooseStoredVoice(voice: LiveVoice): void {
  saveVoice(voice)
  for (const listener of voiceHub) listener()
}

export interface LiveClientState {
  phase: LivePhase | 'idle'
  stage?: string
  dialStartedAt?: number
  connectedAt?: number
  muted: boolean
  inputLevel: number
  outputLevel: number
  transcript?: { role: 'user' | 'assistant'; text: string; final: boolean }
  microphoneBlocked?: boolean
  error?: string
  errorKind?: LiveFailureKind
  mediaWarning?: string
  usageSource?: LiveUsageSource
  usageMetrics?: readonly LiveUsageMetric[]
  voice: LiveVoice
  status?: LiveStatus
  capture?: string
  receipts: readonly LiveTaskReceipt[]
}

export type LiveClientListener = (state: LiveClientState) => void

export class LiveClientSession {
  private readonly listeners = new Set<LiveClientListener>()
  private peer: LivePeer | undefined
  private playback: PreparedPlayback | undefined
  private remoteStream: MediaStream | undefined
  private stopEvents: (() => void) | undefined
  private stopInputLevels: (() => void) | undefined
  private readonly inputActivity = new InputActivityDetector()
  private inputActivitySequence = 0
  private callToken: string | undefined
  private startAbort: AbortController | undefined
  private starting = false
  private startGen = 0
  private sessionProofReady = false
  private pendingPhase: LivePhase | undefined
  private sessionProofWaiter: {
    resolve(): void
    reject(error: Error): void
    timer: number
  } | undefined
  private state: LiveClientState = {
    phase: 'idle',
    muted: false,
    inputLevel: 0,
    outputLevel: 0,
    voice: loadVoice(),
    receipts: [],
  }

  constructor(private readonly sessionId: string) {
    subscribeStoredVoice(() => {
      const next = loadVoice()
      if (next === this.state.voice) return
      if (this.state.phase !== 'idle' || this.starting) return
      this.patch({ voice: next })
    })
  }

  get snapshot(): LiveClientState {
    return this.state
  }

  subscribe(listener: LiveClientListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => { this.listeners.delete(listener) }
  }

  async refreshStatus(expectedGen?: number): Promise<void> {
    try {
      const status = await fetchLiveStatus()
      if (expectedGen !== undefined && expectedGen !== this.startGen) return
      this.patch({ status, voice: resolveLiveVoice(this.state.voice || status.defaultVoice) })
    } catch (error) {
      if (expectedGen !== undefined && expectedGen !== this.startGen) return
      this.patch({
        status: {
          ready: false,
          source: 'none',
          voices: [],
          defaultVoice: DEFAULT_LIVE_VOICE,
        },
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  setVoice(voice: LiveVoice): void {
    saveVoice(voice)
    this.patch({ voice })
  }

  async switchVoice(voice: LiveVoice): Promise<void> {
    const previous = this.state.voice
    this.setVoice(voice)
    if (voice === previous) return
    if (this.state.phase === 'idle' && !this.starting) return
    await this.stop()
    await this.start()
  }

  async toggle(): Promise<void> {
    if (this.state.phase !== 'idle') {
      await this.stop()
      return
    }
    await this.start()
  }

  retryPlayback(): void {
    this.playback?.retry()
  }

  toggleMute(): void {
    if (this.state.phase === 'idle') return
    const muted = !this.state.muted
    this.inputActivity.reset()
    // Keep RTP disabled throughout dialing; this records the user's eventual
    // mute choice without turning a mute toggle into a readiness transition.
    this.peer?.setMuted(this.starting ? true : muted)
    this.patch({
      muted,
      phase: this.state.phase === 'connecting'
        ? 'connecting'
        : muted ? 'muted' : this.state.phase === 'muted' ? 'listening' : this.state.phase,
      inputLevel: muted ? 0 : this.state.inputLevel,
    })
  }

  async start(): Promise<void> {
    if (this.state.phase !== 'idle') return
    const gen = ++this.startGen
    const abort = new AbortController()
    this.startAbort = abort
    this.starting = true
    this.inputActivity.reset()
    this.inputActivitySequence = 0
    this.sessionProofReady = false
    this.pendingPhase = undefined
    this.patch({
      phase: 'connecting',
      stage: 'dial.mic',
      dialStartedAt: Date.now(),
      error: undefined,
      microphoneBlocked: false,
      transcript: undefined,
      voice: loadVoice(),
    })
    const playback = unlockPlayback()
    this.playback = playback
    try {
      if (this.state.status?.ready !== true) {
        await this.refreshStatus(gen)
      }
      if (gen !== this.startGen) return
      if (this.state.status?.ready !== true) {
        throw new LiveCallError(
          this.state.status
            ? 'No Codex OAuth credential is available. Sign in to ChatGPT Codex first.'
            : 'Live voice status is unavailable.',
          'auth',
        )
      }
      this.patch({ stage: 'dial.offer' })
      const created = await createLivePeer({
        onRemoteStream: stream => {
          if (gen !== this.startGen) {
            stream.getTracks().forEach(track => track.stop())
            return
          }
          this.remoteStream = stream
          playback.attach(stream)
        },
        onIceState: (iceState) => {
          if (gen !== this.startGen) return
          if (this.state.phase === 'connecting' || this.starting) {
            this.patch({ stage: 'dial.media' })
            return
          }
          if (iceState === 'connected' || iceState === 'completed') {
            if (this.state.mediaWarning) this.patch({ mediaWarning: undefined })
            return
          }
          if (iceState === 'disconnected') {
            this.patch({ mediaWarning: 'media.warning' })
            return
          }
          if (iceState === 'failed' || iceState === 'closed') {
            void this.stop(
              'Live voice media dropped after the call was up. This is the browser audio path to OpenAI, not a Codex quota error.',
              'media',
            )
          }
        },
        onControlPayload: payload => {
          if (gen === this.startGen) this.applyControlPayload(payload)
        },
        onMicrophoneEnded: () => {
          if (gen !== this.startGen) return
          void this.stop(
            'Microphone capture ended. Reconnect your microphone, then try again.',
            'media',
          )
        },
        signal: abort.signal,
      })
      if (gen !== this.startGen) {
        created.peer.close()
        return
      }
      this.peer = created.peer
      created.peer.setMuted(true)
      this.patch({ capture: created.peer.captureLabel })
      this.stopInputLevels = createLevelMonitor(created.peer.localStream, (level) => {
        if (gen !== this.startGen) return
        if (this.state.muted) {
          if (this.state.inputLevel !== 0) this.patch({ inputLevel: 0 })
          return
        }
        if (Math.abs(level - this.state.inputLevel) < 0.02) return
        this.patch({ inputLevel: level })
      }, (level, now) => {
        if (gen !== this.startGen) return
        const enabled = !this.starting && !this.state.muted && this.callToken !== undefined
          && this.state.phase !== 'idle' && this.state.phase !== 'connecting'
          && created.peer.isMicrophoneUsable()
        const speaking = this.inputActivity.observe(level, now, enabled)
        if (speaking !== undefined) this.sendInputActivity(gen, speaking)
      })
      this.patch({ stage: 'dial.codex' })
      const call = await startLiveCall({
        sessionId: this.sessionId,
        sdp: created.offer,
        voice: this.state.voice,
      })
      if (gen !== this.startGen) {
        try {
          await stopLiveCall(call.callToken)
        } catch {
          // A cancelled late response may already have been closed server-side.
        }
        return
      }
      this.callToken = call.callToken
      this.stopEvents = subscribeLiveEvents(call.callToken, (event) => {
        if (gen === this.startGen) this.handleEvent(event)
      })
      this.patch({ stage: 'dial.media' })
      await acceptLiveAnswer(created.peer, call.answer)
      if (gen !== this.startGen) return
      this.trace('ice+oai-events')
      this.patch({ stage: 'dial.ear' })
      await this.waitForSessionProof(20_000)
      if (gen !== this.startGen || !this.peer) return
      if (!created.peer.isMicrophoneUsable()) {
        throw new Error('Microphone capture ended before the live session became ready.')
      }
      created.peer.setMuted(this.state.muted)
      const pendingPhase = this.pendingPhase
      this.pendingPhase = undefined
      this.patch({
        phase: this.state.muted
          ? 'muted'
          : pendingPhase && pendingPhase !== 'connecting' ? pendingPhase : 'listening',
        stage: undefined,
        dialStartedAt: undefined,
        connectedAt: Date.now(),
      })
    } catch (error) {
      if (gen !== this.startGen || this.state.phase === 'idle') return
      this.patch({ microphoneBlocked: error instanceof MicrophoneAccessError })
      await this.stop(
        error instanceof Error ? error.message : String(error),
        liveFailureKind(error),
      )
    } finally {
      if (this.startAbort === abort) this.startAbort = undefined
      if (gen === this.startGen) this.starting = false
    }
  }

  async stop(error?: string, kind?: LiveFailureKind): Promise<void> {
    this.startGen += 1
    this.starting = false
    this.inputActivity.reset()
    this.startAbort?.abort()
    this.startAbort = undefined
    this.rejectSessionProof(new Error('Live voice start was cancelled'))
    this.sessionProofReady = false
    this.pendingPhase = undefined
    const callToken = this.callToken
    this.callToken = undefined
    this.stopEvents?.()
    this.stopEvents = undefined
    this.stopInputLevels?.()
    this.stopInputLevels = undefined
    this.playback?.stop()
    this.playback = undefined
    this.remoteStream = undefined
    this.peer?.close()
    this.peer = undefined
    this.patch({
      phase: 'idle',
      stage: undefined,
      dialStartedAt: undefined,
      connectedAt: undefined,
      muted: false,
      inputLevel: 0,
      outputLevel: 0,
      capture: undefined,
      mediaWarning: undefined,
      usageSource: undefined,
      usageMetrics: undefined,
      receipts: stopTrackingLiveTaskReceipts(this.state.receipts),
      ...error === undefined
        ? { error: this.state.error, errorKind: this.state.errorKind }
        : { error, errorKind: kind },
    })
    if (callToken) {
      try {
        await stopLiveCall(callToken)
      } catch {
        // Local teardown still completes if the host call is already gone.
      }
    }
  }

  private sendInputActivity(gen: number, speaking: boolean): void {
    const callToken = this.callToken
    if (gen !== this.startGen || callToken === undefined) return
    const sequence = ++this.inputActivitySequence
    void sendLiveInputActivity(callToken, sequence, speaking).catch(error => {
      if (gen !== this.startGen || callToken !== this.callToken) return
      const detail = error instanceof Error ? error.message : String(error)
      void this.stop(`Could not report microphone activity: ${detail}. Try again.`, 'network')
    })
  }

  private applyControlPayload(payload: string): void {
    const event = parseLiveServerEvent(payload)
    if (event?.type === 'session.started' || event?.type === 'session.updated') {
      this.markSessionProofReady()
    }
    if (event?.type === 'error') this.handleEvent({ type: 'error', message: event.message })
  }

  private handleEvent(event: LiveUiEvent): void {
    if (event.type === 'playback') {
      this.playback?.setEnabled(event.enabled)
      return
    }
    if (event.type === 'ready') {
      this.markSessionProofReady()
      return
    }
    if (event.type === 'phase') {
      if (this.starting) {
        this.pendingPhase = event.phase
        return
      }
      const phase = this.state.muted ? 'muted' : event.phase
      this.patch({
        phase,
        ...event.phase === 'listening' || event.phase === 'speaking' || event.phase === 'working' || event.phase === 'error'
          ? { stage: undefined, dialStartedAt: undefined }
          : {},
      })
      return
    }
    if (event.type === 'transcript') {
      this.patch({
        transcript: event.transcript
          ? { role: event.transcript.role, text: event.transcript.text, final: event.transcript.final }
          : undefined,
        ...this.starting ? {} : { stage: undefined },
      })
      return
    }
    if (event.type === 'task-receipt') {
      this.patch({ receipts: mergeLiveTaskReceipt(this.state.receipts, event.receipt) })
      return
    }
    if (event.type === 'usage') {
      this.patch({ usageSource: event.source, usageMetrics: event.metrics })
      return
    }
    if (event.type === 'error') {
      void this.stop(event.message, event.kind)
      return
    }
    if (event.type === 'closed') {
      void this.stop()
    }
  }

  private waitForSessionProof(ms: number): Promise<void> {
    if (this.sessionProofReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.sessionProofWaiter = undefined
        reject(new Error('Codex live session did not become ready within 20 seconds.'))
      }, ms)
      this.sessionProofWaiter = { resolve, reject, timer }
    })
  }

  private markSessionProofReady(): void {
    if (!this.sessionProofReady) this.trace('session-proof')
    this.sessionProofReady = true
    const waiter = this.sessionProofWaiter
    if (!waiter) return
    window.clearTimeout(waiter.timer)
    this.sessionProofWaiter = undefined
    waiter.resolve()
  }

  private rejectSessionProof(error: Error): void {
    const waiter = this.sessionProofWaiter
    if (!waiter) return
    window.clearTimeout(waiter.timer)
    this.sessionProofWaiter = undefined
    waiter.reject(error)
  }

  private trace(label: string): void {
    const started = this.state.dialStartedAt
    const elapsed = started === undefined ? 0 : Date.now() - started
    console.log(`[dsh-livevoice] +${elapsed}ms ${label}`)
  }

  private patch(patch: Partial<LiveClientState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}

function liveFailureKind(error: unknown): LiveFailureKind {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return 'unknown'
  const kind = error.kind
  return typeof kind === 'string' && isLiveFailureKind(kind) ? kind : 'unknown'
}

function loadVoice(): LiveVoice {
  try {
    return resolveLiveVoice(window.localStorage.getItem(VOICE_KEY) ?? undefined)
  } catch {
    return DEFAULT_LIVE_VOICE
  }
}

function saveVoice(voice: LiveVoice): void {
  try {
    window.localStorage.setItem(VOICE_KEY, voice)
  } catch {
    // Private mode can refuse localStorage.
  }
}
