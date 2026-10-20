import { MicrophoneAccessError } from './microphone-error.js'
import { LIVE_EVENTS_CHANNEL } from '../protocol.js'
import { prepareRemoteSdp } from '../sdp.js'

export { prepareRemoteSdp, normalizeSdp } from '../sdp.js'
export { LIVE_EVENTS_CHANNEL } from '../protocol.js'

const ICE_GATHER_MS = 8_000
const ICE_CONNECT_MS = 12_000
const EVENTS_OPEN_MS = 12_000

export interface LivePeer {
  readonly pc: RTCPeerConnection
  readonly localStream: MediaStream
  readonly eventsChannel: RTCDataChannel
  readonly captureLabel: string
  isMicrophoneUsable(): boolean
  setMuted(muted: boolean): void
  close(): void
}

export async function createLivePeer(options: {
  onRemoteStream(stream: MediaStream): void
  onIceState(state: string): void
  onMicrophoneEnded?(): void
  onControlPayload?(payload: string): void
  signal?: AbortSignal
}): Promise<{ peer: LivePeer; offer: string }> {
  const localStream = await captureMicrophone(options.signal)
  let pc: RTCPeerConnection | undefined
  let stopCaptureWatch: (() => void) | undefined
  const dispose = (): void => {
    stopCaptureWatch?.()
    stopCaptureWatch = undefined
    localStream.getTracks().forEach(track => track.stop())
    pc?.close()
  }
  throwIfAborted(options.signal, dispose)
  const audioTrack = localStream.getAudioTracks()[0]
  if (audioTrack === undefined) {
    dispose()
    throw new Error('Microphone track is missing')
  }
  // Device removal can end capture while ICE remains connected. A temporary
  // track mute is recoverable, so only a permanent end terminates the call.
  const onCaptureEnded = (): void => { options.onMicrophoneEnded?.() }
  audioTrack.addEventListener('ended', onCaptureEnded, { once: true })
  stopCaptureWatch = () => audioTrack.removeEventListener('ended', onCaptureEnded)
  let captureLabel: string
  try {
    captureLabel = await waitForMicCapture(audioTrack, options.signal)
    throwIfAborted(options.signal, dispose)
  } catch (error) {
    dispose()
    throw error
  }
  // Prove capture first, then keep RTP gated until the client has both the
  // connected transport and an actual session.started/session.updated event.
  audioTrack.enabled = false

  pc = new RTCPeerConnection({
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  })
  const peerConnection = pc
  const reportTransport = (): void => {
    if (peerConnection.connectionState === 'failed') {
      options.onIceState('failed')
      return
    }
    options.onIceState(peerConnection.iceConnectionState)
  }
  peerConnection.addEventListener('iceconnectionstatechange', reportTransport)
  peerConnection.addEventListener('connectionstatechange', reportTransport)
  let delivered = false
  peerConnection.addEventListener('track', (event) => {
    if (event.track.kind !== 'audio' || delivered) return
    delivered = true
    const stream = event.streams[0] ?? new MediaStream([event.track])
    options.onRemoteStream(stream)
  })

  const eventsChannel = peerConnection.createDataChannel(LIVE_EVENTS_CHANNEL, { ordered: true })
  eventsChannel.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    options.onControlPayload?.(event.data)
  })
  const transceiver = peerConnection.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [localStream] })
  preferOpus(transceiver)

  let offer: RTCSessionDescriptionInit
  try {
    offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
    throwIfAborted(options.signal, dispose)
    await peerConnection.setLocalDescription(offer)
    throwIfAborted(options.signal, dispose)
    await waitForIceGathering(peerConnection, options.signal)
    throwIfAborted(options.signal, dispose)
  } catch (error) {
    dispose()
    throw error
  }
  const sdp = peerConnection.localDescription?.sdp
  if (!sdp || !sdp.includes('m=audio') || !sdp.includes('m=application')) {
    dispose()
    throw new Error('WebRTC produced an offer without audio or the oai-events data channel')
  }
  return {
    offer: sdp,
    peer: {
      pc: peerConnection,
      localStream,
      eventsChannel,
      captureLabel,
      isMicrophoneUsable() {
        return audioTrack.readyState === 'live' && !audioTrack.muted
      },
      setMuted(value) {
        audioTrack.enabled = !value
      },
      close() {
        eventsChannel.close()
        dispose()
      },
    },
  }
}

export async function acceptLiveAnswer(peer: LivePeer, answer: string): Promise<void> {
  const sdp = prepareRemoteSdp(answer)
  if (!sdp.startsWith('v=')) throw new Error('Codex returned a non-SDP answer')
  if (!sdp.includes('m=application')) {
    throw new Error('Codex returned an SDP answer without the oai-events data channel')
  }
  await peer.pc.setRemoteDescription({ type: 'answer', sdp })
  await Promise.all([waitForIceConnected(peer.pc), waitForEventsChannel(peer.eventsChannel)])
}

export async function captureMicrophone(signal?: AbortSignal): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { stream: MediaStream } | { error: Error }): void => {
      if (settled) {
        if ('stream' in result) result.stream.getTracks().forEach(track => track.stop())
        return
      }
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if ('stream' in result) resolve(result.stream)
      else reject(result.error)
    }
    const onAbort = (): void => { finish({ error: new Error('Live voice start was cancelled') }) }
    const timer = window.setTimeout(() => {
      finish({ error: new Error('Microphone permission timed out') })
    }, 15_000)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
        },
      })
      .then(stream => finish({ stream }))
      .catch((error: unknown) => {
        const name = error instanceof DOMException ? error.name : ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          finish({ error: new MicrophoneAccessError() })
          return
        }
        finish({ error: error instanceof Error ? error : new Error(String(error)) })
      })
  })
}

async function waitForMicCapture(track: MediaStreamTrack, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (track.readyState !== 'live') {
      throw new Error('Microphone track ended before capture started')
    }
    if (!track.muted) {
      const settings = track.getSettings()
      return track.label || settings.deviceId || 'microphone'
    }
    await waitForTrackUnmute(track, signal)
  }
  throw new Error(
    `麦克风一直处于 muted（${track.readyState}）。系统状态栏没有橙色录音点，Codex 只能收到静音。`,
  )
}

function waitForTrackUnmute(track: MediaStreamTrack, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      track.removeEventListener('unmute', onUnmute)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(() => finish(), 80)
    const onUnmute = (): void => { finish() }
    const onAbort = (): void => { finish(new Error('Live voice start was cancelled')) }
    track.addEventListener('unmute', onUnmute, { once: true })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal | undefined, dispose: () => void): void {
  if (!signal?.aborted) return
  dispose()
  throw new Error('Live voice start was cancelled')
}

function preferOpus(transceiver: RTCRtpTransceiver): void {
  const capabilities = RTCRtpSender.getCapabilities?.('audio')
  if (capabilities == null || typeof transceiver.setCodecPreferences !== 'function') return
  const opus = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus')
  if (opus.length > 0) transceiver.setCodecPreferences(opus)
}

function waitForIceGathering(pc: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onGathering)
      pc.removeEventListener('icecandidate', onCandidate)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(finish, ICE_GATHER_MS)
    const onGathering = (): void => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const onCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (event.candidate === null) finish()
    }
    const onAbort = (): void => { finish(new Error('Live voice start was cancelled')) }
    pc.addEventListener('icegatheringstatechange', onGathering)
    pc.addEventListener('icecandidate', onCandidate)
    if (signal?.aborted) onAbort()
    else {
      signal?.addEventListener('abort', onAbort, { once: true })
      if (pc.iceGatheringState === 'complete') finish()
    }
  })
}

function waitForIceConnected(pc: RTCPeerConnection): Promise<void> {
  const connected = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'
    || pc.connectionState === 'connected'
  if (connected) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      pc.removeEventListener('iceconnectionstatechange', onState)
      pc.removeEventListener('connectionstatechange', onState)
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(() => {
      finish(new Error(
        `WebRTC ICE 未连通（${pc.iceConnectionState}）。控制通道能连上，但语音媒体穿不过当前网络/代理。`,
      ))
    }, ICE_CONNECT_MS)
    const onState = (): void => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'
        || pc.connectionState === 'connected') {
        finish()
        return
      }
      if (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed') {
        finish(new Error('WebRTC ICE failed. Live voice media did not reach Codex.'))
      }
    }
    pc.addEventListener('iceconnectionstatechange', onState)
    pc.addEventListener('connectionstatechange', onState)
    onState()
  })
}

function waitForEventsChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(() => {
      finish(new Error('Codex oai-events 数据通道未打开。ICE 通了也不算通话真正开始。'))
    }, EVENTS_OPEN_MS)
    const onOpen = (): void => { finish() }
    const onError = (): void => {
      finish(new Error('Codex oai-events 数据通道失败'))
    }
    channel.addEventListener('open', onOpen)
    channel.addEventListener('error', onError)
    if (channel.readyState === 'open') finish()
  })
}
