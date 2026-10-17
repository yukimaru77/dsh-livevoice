# dsh-livevoice

## Install

### Official DeepSeek Harness desktop app

Open **Settings → Plugins → Add plugin** and enter this in “Package name or address”:

```text
dsh-livevoice@npm:@aa2246740/dsh-livevoice@0.1.6
```

The desktop plugin manager owns the Desktop profile and bundled package manager. This release includes built `lib/`; normal use needs no clone, build, or DSHX installation. Follow the app if it asks you to reload or reopen after installation.

### Web CLI

```sh
dsh plugin --profile web add dsh-livevoice@npm:@aa2246740/dsh-livevoice@0.1.6
```

This official CLI command writes only the `web` profile; it cannot modify the Desktop App profile. For an already-running Web Host, reopen that Host once and reload the page because bundles are read at boot.

Codex realtime voice (`Ctrl+L` / `/live`) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a protocol-complete port of omp’s GPT-Live path: ChatGPT OAuth, WebRTC media, Frameless Bidi sideband, client-side delegation into the current DSH session. It is not a local STT/TTS plugin.

## Compatibility

The current source targets official DeepSeek Harness **0.2.1-rc.2** (`dsh-v0.2.1-rc.2`, SHA `687f282e8625c6b8d11ff58211a90524be2e4317`, npm `@deepseek-ai/dsh@0.2.1-rc.2`). Harness peers and `engines.dsh` are `>=0.2.1-rc.1 <0.2.2`. That range accepts `0.2.1-rc.1`, `0.2.1-rc.2`, and stable `0.2.1`, rejects `0.2.1` alphas, and rejects `0.2.0-rc.2`.

## Other install paths (development/local testing)

Local checkout or tarball:

```sh
git clone https://github.com/aa2246740/dsh-livevoice.git
dsh plugin --profile web add ./dsh-livevoice
dsh plugin --profile web add ./dsh-livevoice-0.1.6.tgz
```

```sh
dsh plugin --profile web remove dsh-livevoice
```

## Auth: OAuth is required

Live voice **cannot** use a normal OpenAI platform API key or the default DeepSeek LLM login. Signaling posts to `https://chatgpt.com/backend-api/codex/realtime/calls` with a ChatGPT / Codex OAuth access token and a `Codex Desktop` originator.

The plugin does **not** depend on `dsh-oauth-login` being loaded. It reads credentials in this order:

1. `$DSH_HOME/.dsh-oauth-auth.json` (`openai-codex`) — written by **dsh-oauth-login** / 订阅登录
2. DSH credential store `llm-pi-ai/openai-codex` — official **Settings → models → ChatGPT Codex OAuth**
3. `~/.codex/auth.json` — official `codex login` (read-only fallback)

If none of those hold an OAuth grant, the Live button fails with `No Codex OAuth credential is available for a live call.`

`dsh-oauth-login` is the usual way to get that grant inside DSH, but a user who already signed in through DSH’s built-in `openai-codex` OAuth flow is enough. A DeepSeek API key is not.

## What is ported

| omp | DSH |
|---|---|
| `protocol.ts` Frameless Bidi | same types and codecs |
| Codex signaling + sideband | Host proxy (avoids browser CORS / WS headers) |
| Native WebRTC / Opus | Browser `RTCPeerConnection` + `getUserMedia` |
| `AgentSession.sendCustomMessage` | `agent.steer` while a turn is open; `agent.followup` when idle or running with no open turn |
| TUI visualizer | composer Live chip + live bar |
| `Ctrl+L` / `/live` | same |
| DeviceCheck attestation | not ported (omp also skips this off Apple silicon) |

The voice model is `gpt-live-1-codex`. It only talks. Repository work is delegated into this DSH session.

Delegation preserves the user's current wording. A bounded recent transcript is attached separately so the worker can resolve references and sentence fragments without inheriting broader authorization: asking how a change could be done remains analysis, while an explicit request to do it authorizes execution. Read-only repository and session-status questions may be delegated.

## Use

Composer **Live** button, or `Ctrl+L`, or `/live`. Esc ends the call. Space mutes while the live bar is focused.

“Ready — speak now” is shown only after WebRTC media/data-channel connection, an explicit Codex session-ready event, and a live microphone track. Until then the UI remains connecting and microphone transmission stays gated. A readiness timeout fails with a retry action; it never silently counts as connected. You can cancel while dialing.

The Host maintains one live call across browser pages. Concurrent dials are serialized; a later dial replaces the earlier call. Failed dials do not block the queue, and shutdown waits for earlier dial attempts before clearing their calls.

The live dock shows task receipts for the actual input and handoff sent to DSH. States come from dispatch, matching `agent/inbox/claimed`, `agent/inbox/discarded`, and the claimed turn's `turn/end` reason. “Worker replied” means only that a completed turn produced a response associated with the request; it is not verification of the work.

Changing topics does not erase earlier answers. The bridge retains every non-tool response and associates it with requests consumed by the worker before that response. A later unclaimed request cannot receive an earlier answer; if several requests were consumed together, their answer is explicitly labeled shared, not independently fulfilled. Replies are returned at the end of their claimed turn even when another request is still queued for the next turn. Actual terminal states also go to the voice context, so it can report no reply, cancellation, failure, or stopped tracking instead of promising a nonexistent future result. There is no semantic topic classifier or extra worker process. This is an event-based approximation of answer ownership, not a guarantee of semantic correctness or 100% Codex behavior parity.

Results and unsuccessful terminal outcomes use the explicit `speakable` context channel; routine progress and successful receipt metadata use `commentary`. These are the existing [Frameless Bidi channels](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs), not a new transport or a promise that speech generation is infallible.

The server replays current-call receipts when the SSE connection reconnects and keeps all active receipts plus the 24 most recent settled receipts. The current page keeps its existing cards after hangup, when another call replaces the current call, and across a redial; replacement stops live tracking for the old call. Refreshing the page loses page-local history, and a newly opened page cannot retrieve receipts from an old replaced call because there is deliberately no new database. When a call ends while DSH work continues, its card freezes at “Call ended · follow in session” instead of pretending the work failed or completed.

Voice names match Codex: arbor, breeze, cove, ember, juniper, maple, sol, spruce, vale.

HTTP/WS outbound honors `$DSH_HOME/.dsh-oauth-proxy.json` (same file as dsh-oauth-login) and `HTTPS_PROXY`. Browser audio uses WebRTC from the current device to OpenAI; being on this machine or the same LAN only means the control plane goes through DSH.

## Rebuild committed lib/

Stock install uses the committed `lib/`. After TypeScript edits, rebuild with **pnpm**:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

### macOS 麦克风恢复（0.1.4）

实时语音需要客户端签名包含 `com.apple.security.device.audio-input`。缺少该声明时，macOS 不会弹出授权窗口；插件会给出准确提示。权限被拒绝时，可直接打开麦克风设置，并执行不连接模型的麦克风检测。支持官方客户端和 DSH Studio 自用客户端。

### 本地麦克风检测

在通用设置中点击“检测麦克风（不连接模型）”。检测只申请本机采集并立即释放音轨，不连接语音模型、不上传录音。官方 DSH 0.2.1-rc.2 的 macOS 壳已包含 audio-input entitlement。
