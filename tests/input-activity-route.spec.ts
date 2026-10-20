import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveCallRegistry } from '../src/controller.js'
import type { LiveProxy } from '../src/proxy.js'
import { LIVE_INPUT_ACTIVITY_PATH } from '../src/ids.js'
vi.mock('../src/auth.js', () => ({ CodexAuthError: class extends Error {}, describeCodexAuth: vi.fn() }))
vi.mock('../src/signaling.js', () => ({ warmupLiveSignaling: vi.fn() }))
import { registerLiveVoiceRoutes } from '../src/routes.js'
import { sendLiveInputActivity } from '../src/client/api.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown
let handler: Handler
const setInputActivity = vi.fn()
beforeEach(() => {
  setInputActivity.mockReset()
  const registry = { get: (token: string) => token === 'fixture-token' ? { setInputActivity } : undefined }
  const web = { effect: (fn: () => unknown) => fn(), webServer: { register: (route: { path: string; handler: Handler }) => {
    if (route.path === LIVE_INPUT_ACTIVITY_PATH) handler = route.handler
    return () => {}
  } } }
  registerLiveVoiceRoutes(
    { inject: (_keys: string[], callback: (ctx: unknown) => unknown) => callback(web) } as unknown as Context,
    registry as unknown as LiveCallRegistry,
    {} as LiveProxy,
  )
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function invoke(body: unknown, method = 'POST', origin?: string) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:1234', ...(origin ? { origin } : {}) },
  })
  const res = { writeHead: vi.fn(), end: vi.fn() }
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return { status: res.writeHead.mock.calls[0][0], body: JSON.parse(res.end.mock.calls[0][0]) }
}

describe('input activity HTTP route', () => {
  it('routes monotonic sequence values and both speaking states to the addressed call', async () => {
    expect((await invoke({ callToken: 'fixture-token', sequence: 1, speaking: true })).status).toBe(200)
    expect((await invoke({ callToken: 'fixture-token', sequence: 2, speaking: false })).status).toBe(200)
    expect(setInputActivity.mock.calls).toEqual([[1, true], [2, false]])
  })

  it('rejects other origins, methods, missing calls and malformed activity values', async () => {
    const valid = { callToken: 'fixture-token', sequence: 1, speaking: true }
    expect((await invoke(valid, 'GET')).status).toBe(405)
    expect((await invoke(valid, 'POST', 'https://elsewhere.example')).status).toBe(403)
    expect((await invoke({ ...valid, callToken: 'previous-call' })).status).toBe(404)
    for (const patch of [{ sequence: 0 }, { sequence: -1 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: '1' }, { speaking: 'false' }, { callToken: '' }]) {
      expect((await invoke({ ...valid, ...patch })).status).toBe(400)
    }
    expect(setInputActivity).not.toHaveBeenCalled()
  })
})

describe('input activity client transport', () => {
  it('sends only the call token, sequence and acoustic state in a same-origin POST', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"accepted":true}'))
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('fetch', fetch)
    await sendLiveInputActivity('fixture-token', 3, false)
    expect(fetch).toHaveBeenCalledWith(LIVE_INPUT_ACTIVITY_PATH, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ callToken: 'fixture-token', sequence: 3, speaking: false }),
    }))
  })

  it('propagates HTTP failures instead of pretending the input boundary was delivered', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"live call not found"}', { status: 404 })))
    await expect(sendLiveInputActivity('previous-call', 1, true)).rejects.toThrow('live call not found')
  })

  it('times out an unresponsive activity request', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const result = sendLiveInputActivity('fixture-token', 1, true).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await result).toMatchObject({ kind: 'network', message: 'Live voice request timed out after 5s' })
  })
})
