import { afterEach, expect, it, vi } from 'vitest'
import { enclosingMacApp, missingAudioEntitlement } from '../src/microphone-host.js'
import { captureMicrophone, createLivePeer } from '../src/client/webrtc.js'
import { MicrophoneAccessError } from '../src/client/microphone-error.js'
import { testMicrophone } from '../src/client/MicrophoneRecovery.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function media(getUserMedia: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
}
it('inspects the enclosing App only, not an arbitrary global installation', () => {
  expect(enclosingMacApp('/Users/user/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node')).toBe('/Users/user/Applications/DeepSeek Harness.app')
  expect(enclosingMacApp('/usr/local/bin/node')).toBeUndefined()
})
it('distinguishes a missing signing entitlement from user denial or unknown signatures', () => {
  expect(missingAudioEntitlement('flags=0x10000(runtime)', '[Dict]')).toBe(true)
  expect(missingAudioEntitlement('flags=0x10000(runtime)', '<key>com.apple.security.device.audio-input</key><true/>')).toBe(false)
  expect(missingAudioEntitlement('flags=0x10000(runtime)', '[Key] com.apple.security.device.audio-input\n[Value]\n[Bool] true')).toBe(false)
  expect(missingAudioEntitlement('flags=0x10000(runtime)', '<key>com.apple.security.device.audio-input</key><false/>')).toBe(true)
  expect(missingAudioEntitlement('flags=0x10000(runtime)', '<key>com.apple.security.device.audio-input</key><false/><key>other</key><true/>')).toBe(true)
  expect(missingAudioEntitlement('', '')).toBe(false)
})
it('does not blame the user or prescribe a restart on NotAllowedError', async () => {
  media(vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')))
  await expect(captureMicrophone()).rejects.toBeInstanceOf(MicrophoneAccessError)
})
it('permission-only test stops every track and never contacts a model', async () => {
  const stop = vi.fn(), fetch = vi.fn()
  const track = { readyState: 'live', muted: false, stop }
  media(vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }))
  vi.stubGlobal('fetch', fetch)
  await testMicrophone()
  expect(stop).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
})
it('stops muted tracks even when local detection fails', async () => {
  const stop = vi.fn(), track = { readyState: 'live', muted: true, stop }
  media(vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }))
  await expect(testMicrophone()).rejects.toThrow('没有提供可用音轨')
  expect(stop).toHaveBeenCalledOnce()
})
it('stops late microphone capture after the permission view is dismissed', async () => {
  const capture = Promise.withResolvers<MediaStream>(), stop = vi.fn()
  media(vi.fn().mockReturnValue(capture.promise))
  const abort = new AbortController(), request = captureMicrophone(abort.signal)
  abort.abort()
  await expect(request).rejects.toThrow('cancelled')
  capture.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
  await Promise.resolve(); await Promise.resolve()
  expect(stop).toHaveBeenCalledOnce()
})

function peerCapture() {
  class Track extends EventTarget {
    readyState = 'live'
    muted = false
    enabled = true
    label = 'fixture microphone'
    getSettings() { return {} }
    stop = vi.fn(() => { this.readyState = 'ended' })
  }
  const track = new Track()
  media(vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] }))
  const channelClose = vi.fn()
  const peerClose = vi.fn()
  class Peer extends EventTarget {
    iceGatheringState = 'complete'
    localDescription: RTCSessionDescriptionInit | undefined
    createDataChannel() { return Object.assign(new EventTarget(), { close: channelClose }) }
    addTransceiver() { return {} }
    async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\nm=audio 9 RTP/AVP 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' } }
    async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value }
    close = peerClose
  }
  vi.stubGlobal('RTCPeerConnection', Peer)
  vi.stubGlobal('RTCRtpSender', {})
  return { track, channelClose, peerClose }
}

it('reports permanent microphone loss but tolerates temporary track muting', async () => {
  const { track } = peerCapture()
  const onMicrophoneEnded = vi.fn()
  const { peer } = await createLivePeer({
    onRemoteStream: vi.fn(), onIceState: vi.fn(), onMicrophoneEnded,
  })
  track.muted = true
  track.dispatchEvent(new Event('mute'))
  track.muted = false
  track.dispatchEvent(new Event('unmute'))
  expect(onMicrophoneEnded).not.toHaveBeenCalled()
  expect(peer.isMicrophoneUsable()).toBe(true)

  // Device removal emits ended; calling track.stop() ourselves does not.
  track.readyState = 'ended'
  track.dispatchEvent(new Event('ended'))
  expect(onMicrophoneEnded).toHaveBeenCalledOnce()
  expect(peer.isMicrophoneUsable()).toBe(false)
  peer.close()
})

it('removes the capture listener before local shutdown and does not report stale ended events', async () => {
  const { track, channelClose, peerClose } = peerCapture()
  const onMicrophoneEnded = vi.fn()
  const { peer } = await createLivePeer({
    onRemoteStream: vi.fn(), onIceState: vi.fn(), onMicrophoneEnded,
  })
  // Exercise cleanup ordering even if a platform queues an ended event during stop.
  track.stop.mockImplementation(() => {
    track.readyState = 'ended'
    track.dispatchEvent(new Event('ended'))
  })
  peer.close()
  track.dispatchEvent(new Event('ended'))
  expect(onMicrophoneEnded).not.toHaveBeenCalled()
  expect(channelClose).toHaveBeenCalledOnce()
  expect(track.stop).toHaveBeenCalledOnce()
  expect(peerClose).toHaveBeenCalledOnce()
})
