import WebSocket from 'ws'
import type { CodexAccess } from './auth.js'
import { buildLiveSidebandUrl } from './catalog.js'
import { liveSessionHeaders } from './headers.js'
import type { LiveProxy } from './proxy.js'
import {
  buildSessionClose,
  type LiveClientMessage,
  type LiveServerEvent,
  parseLiveServerEvent,
} from './protocol.js'

const SIDEBAND_CONNECT_ATTEMPTS = 2
const SIDEBAND_CONNECT_TIMEOUT_MS = 8_000

export interface LiveSidebandHandlers {
  onEvent(event: LiveServerEvent): void
  onClose(reason: string): void
}

export class LiveSideband {
  #socket: WebSocket | undefined
  #sendTail: Promise<void> = Promise.resolve()
  #closed = false

  constructor(
    private readonly access: CodexAccess,
    private readonly sessionId: string,
    private readonly realtimeSessionId: string,
    private readonly proxy: LiveProxy,
    private readonly handlers: LiveSidebandHandlers,
    private readonly signal?: AbortSignal,
  ) {}

  async connect(callId: string): Promise<void> {
    let failure = new Error('Codex live sideband connection failed')
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.open(callId)
        return
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause))
        if (this.signal?.aborted || this.#closed) throw failure
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) {
          await sleep(200 * 2 ** attempt)
        }
      }
    }
    throw failure
  }

  private async open(callId: string): Promise<void> {
    const url = buildLiveSidebandUrl(callId)
    const socket = new WebSocket(url, {
      headers: liveSessionHeaders(this.access, this.sessionId, this.realtimeSessionId),
      agent: this.proxy.websocketAgent(),
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        socket.close(1000, 'connect timeout')
        finish(new Error('Codex live sideband connection timed out'))
      }, SIDEBAND_CONNECT_TIMEOUT_MS)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = (): void => {
        socket.close(1000, 'aborted')
        finish(this.signal?.reason instanceof Error ? this.signal.reason : new Error('Live connection aborted'))
      }
      socket.once('open', () => {
        this.#socket = socket
        finish()
      })
      socket.once('error', (error) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
      socket.once('close', (code, reason) => {
        if (!settled) {
          finish(new Error(`Codex live sideband closed before connecting (${code})`))
          return
        }
        if (this.#socket !== socket) return
        this.#socket = undefined
        if (!this.#closed) {
          const detail = reason.toString()
          this.handlers.onClose(`Codex live sideband closed (${code})${detail ? `: ${detail}` : ''}`)
        }
      })
      socket.on('message', (data) => {
        const payload = typeof data === 'string' ? data : data.toString()
        const event = parseLiveServerEvent(payload)
        // Unknown types are reported (once per type) by the call controller.
        if (event) this.handlers.onEvent(event)
      })
      if (this.signal?.aborted) onAbort()
      else this.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  send(message: LiveClientMessage): Promise<void> {
    const operation = this.#sendTail.then(() => {
      const socket = this.#socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Codex live sideband is not connected')
      }
      socket.send(JSON.stringify(message))
    })
    this.#sendTail = operation.catch(() => {})
    return operation
  }

  async close(): Promise<void> {
    this.#closed = true
    const socket = this.#socket
    this.#socket = undefined
    if (!socket) return
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(buildSessionClose()))
      } catch {
        // Closing is best-effort once the call is being torn down.
      }
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'done')
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
