const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

export interface PreparedPlayback {
  attach(stream: MediaStream): void
  setEnabled(enabled: boolean): void
  retry(): void
  stop(): void
}

export function applyRemotePlayback(audio: {
  srcObject: MediaProvider | null
  muted: boolean
  volume: number
  autoplay: boolean
}, stream: MediaStream, enabled = true): void {
  audio.srcObject = stream
  audio.muted = !enabled
  audio.volume = enabled ? 1 : 0
  audio.autoplay = true
}

/** Must run inside the user-gesture continuation that started the call. */
export function unlockPlayback(): PreparedPlayback {
  const audio = new Audio()
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  audio.muted = false
  audio.volume = 1
  audio.src = SILENT_WAV
  document.body.appendChild(audio)
  void audio.play().catch(() => {
    // Silent clip is only to unlock the element; remote play is retried on attach.
  })
  let stopped = false
  // Only a backend readout opens playback. ASR remains active while muted.
  let enabled = false
  let remote: MediaStream | undefined
  let context: AudioContext | undefined
  let graph: MediaStreamAudioSourceNode | undefined
  let gain: GainNode | undefined
  const fallbackContext = (): AudioContext => {
    context ??= new AudioContext()
    return context
  }
  const playRemote = (stream: MediaStream): void => {
    if (stopped) return
    remote = stream
    applyRemotePlayback(audio, stream, enabled)
    void audio.play().catch(async () => {
      if (stopped) return
      const audioContext = fallbackContext()
      if (audioContext.state === 'suspended') await audioContext.resume()
      graph?.disconnect()
      const source = audioContext.createMediaStreamSource(stream)
      gain ??= audioContext.createGain()
      gain.gain.value = enabled ? 1 : 0
      gain.disconnect()
      source.connect(gain)
      gain.connect(audioContext.destination)
      graph = source
    })
  }
  return {
    attach: playRemote,
    setEnabled(value) {
      enabled = value
      audio.muted = !value
      audio.volume = value ? 1 : 0
      if (gain) gain.gain.value = value ? 1 : 0
    },
    retry() {
      if (remote) playRemote(remote)
      else void fallbackContext().resume()
    },
    stop() {
      stopped = true
      graph?.disconnect()
      graph = undefined
      gain?.disconnect()
      gain = undefined
      remote = undefined
      audio.pause()
      audio.srcObject = null
      audio.removeAttribute('src')
      audio.remove()
      if (context && context.state !== 'closed') void context.close()
    },
  }
}
