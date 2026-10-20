import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { describeCodexAuth } from './auth.js'
import type { LiveCallHandle, LiveCallRegistry } from './controller.js'
import { liveFailureBody, liveFailureFromUnknown } from './failure.js'
import { json, readJson, trustedRequest, writeSse } from './http.js'
import type { LiveProxy } from './proxy.js'
import { warmupLiveSignaling } from './signaling.js'
import {
  LIVE_MICROPHONE_SETTINGS_PATH,
  LIVE_CALLS_PATH,
  LIVE_EVENTS_PATH,
  LIVE_INPUT_ACTIVITY_PATH,
  LIVE_STATUS_PATH,
  LIVE_STOP_PATH,
} from './ids.js'
import { describeHostMicrophone, openMicrophoneSettings } from './microphone-host.js'
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS } from './voices.js'

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined
}

export function registerLiveVoiceRoutes(ctx: Context, registry: LiveCallRegistry, proxy: LiveProxy): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        warmupLiveSignaling(proxy)
        const auth = await describeCodexAuth(webCtx)
        json(res, 200, {
          microphone: await describeHostMicrophone(),
          ready: auth.ready,
          source: auth.source,
          expired: auth.expired,
          ...auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt },
          ...auth.accountHint === undefined ? {} : { accountHint: auth.accountHint },
          voices: LIVE_VOICE_OPTIONS,
          defaultVoice: DEFAULT_LIVE_VOICE,
        })
      },
    }), 'dsh-livevoice status')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_MICROPHONE_SETTINGS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req) || req.headers['x-dsh-livevoice-action'] !== 'microphone-settings') {
          return json(res, 403, { error: 'forbidden' })
        }
        try { await openMicrophoneSettings(); json(res, 200, { opened: true }) }
        catch { json(res, 503, { error: '无法打开系统设置，请手动打开「隐私与安全性 → 麦克风」。' }) }
      },
    }), 'dsh-livevoice microphone settings')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_CALLS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        let body: unknown
        try {
          body = await readJson(req)
        } catch {
          return json(res, 400, { error: 'invalid json' })
        }
        const sessionId = stringField(body, 'sessionId')
        const offer = stringField(body, 'sdp') ?? stringField(body, 'offer')
        if (!sessionId || !offer) return json(res, 400, { error: 'sessionId and sdp are required' })
        let responseFinished = false
        let requesterGone = false
        let startedCall: LiveCallHandle | undefined
        const closeUnclaimedCall = (): void => {
          if (responseFinished) return
          requesterGone = true
          if (startedCall) {
            void startedCall.close().catch(() => {
              // The requester is already gone; registry ownership was removed
              // before session close, so no later call can be affected.
            })
          }
        }
        req.once('aborted', closeUnclaimedCall)
        res.once('close', closeUnclaimedCall)
        res.once('finish', () => {
          responseFinished = true
          req.off('aborted', closeUnclaimedCall)
          res.off('close', closeUnclaimedCall)
        })
        try {
          console.log('[dsh-livevoice] call start')
          const call = await registry.start({
            sessionId,
            offer,
            voice: stringField(body, 'voice'),
          })
          startedCall = call
          if (requesterGone) {
            await call.close()
            return
          }
          console.log('[dsh-livevoice] call negotiated')
          json(res, 200, {
            callToken: call.callToken,
            callId: call.callId,
            answer: call.answer,
            voice: call.voice,
          })
        } catch (error) {
          if (requesterGone) return
          const failure = liveFailureFromUnknown(error)
          console.error(`[dsh-livevoice] call failed (${failure.kind}): ${failure.message}`)
          json(res, failure.status, liveFailureBody(failure))
        }
      },
    }), 'dsh-livevoice calls')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_EVENTS_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        const url = new URL(req.url ?? '/', 'http://x')
        const callToken = url.searchParams.get('call') ?? ''
        const call = registry.get(callToken)
        if (call === undefined) return json(res, 404, { error: 'live call not found' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        const unsubscribe = call.subscribe((event) => {
          writeSse(res, event.type, event)
          if (event.type === 'closed' || event.type === 'error') {
            unsubscribe()
            res.end()
          }
        })
        req.on('close', () => { unsubscribe() })
      },
    }), 'dsh-livevoice events')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_INPUT_ACTIVITY_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        let body: unknown
        try {
          body = await readJson(req)
        } catch {
          return json(res, 400, { error: 'invalid json' })
        }
        const callToken = stringField(body, 'callToken')
        const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
        const { sequence, speaking } = fields
        if (!callToken || typeof sequence !== 'number' || !Number.isSafeInteger(sequence)
          || sequence < 1 || typeof speaking !== 'boolean') {
          return json(res, 400, { error: 'callToken, positive integer sequence and boolean speaking are required' })
        }
        const call = registry.get(callToken)
        if (call === undefined) return json(res, 404, { error: 'live call not found' })
        call.setInputActivity(sequence, speaking)
        json(res, 200, { accepted: true })
      },
    }), 'dsh-livevoice input activity')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_STOP_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        let body: unknown
        try {
          body = await readJson(req)
        } catch {
          return json(res, 400, { error: 'invalid json' })
        }
        const callToken = stringField(body, 'callToken')
        if (!callToken) return json(res, 400, { error: 'callToken is required' })
        const call = registry.get(callToken)
        if (call === undefined) return json(res, 200, { stopped: true })
        await call.close()
        json(res, 200, { stopped: true })
      },
    }), 'dsh-livevoice stop')
  })
}
