window.__ModuleLoader__.load({
	id: "dsh-livevoice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/ids.ts
		const LIVE_SAY_COMMAND = "livevoice";
		const LIVE_HEAR_COMMAND = "livevoice-hear";
		const LIVE_HTTP_PREFIX = "/plugins/dsh-livevoice";
		const LIVE_STATUS_PATH = `${LIVE_HTTP_PREFIX}/status`;
		const LIVE_CALLS_PATH = `${LIVE_HTTP_PREFIX}/calls`;
		const LIVE_EVENTS_PATH = `${LIVE_HTTP_PREFIX}/events`;
		const LIVE_STOP_PATH = `${LIVE_HTTP_PREFIX}/stop`;
		const LIVE_MICROPHONE_SETTINGS_PATH = `${LIVE_HTTP_PREFIX}/microphone-settings`;
		//#endregion
		//#region src/client/microphone-error.ts
		var MicrophoneAccessError = class extends Error {
			constructor() {
				super("麦克风请求未获准。可能是系统或浏览器权限，也可能是桌面 App 的录音权限声明缺失；这不代表你点过拒绝。");
				this.name = "MicrophoneAccessError";
			}
		};
		//#endregion
		//#region src/protocol.ts
		/** WebRTC data channel Codex and omp wait on before the live call is up. */
		const LIVE_EVENTS_CHANNEL = "oai-events";
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function parsePayload(payload) {
			let parsed = payload;
			if (typeof payload === "string") try {
				parsed = JSON.parse(payload);
			} catch {
				return null;
			}
			return isRecord(parsed) ? parsed : null;
		}
		function parseSessionEvent(type, payload) {
			const session = payload.session;
			if (isRecord(session) && typeof session.id === "string") {
				if (typeof session.instructions === "string") return {
					type,
					session: {
						id: session.id,
						instructions: session.instructions
					}
				};
				return {
					type,
					session: { id: session.id }
				};
			}
			return type === "session.started" ? {
				type,
				session: { id: "" }
			} : null;
		}
		function parseTranscriptAddedEvent(type, payload) {
			const item = payload.item;
			if (!isRecord(item) || typeof item.text !== "string") return null;
			return {
				type,
				item: { text: item.text }
			};
		}
		function parseTurnRole(payload) {
			const turn = payload.turn;
			if (!isRecord(turn) || turn.role !== "user" && turn.role !== "assistant") return null;
			if (typeof turn.transcript !== "string") return null;
			return {
				role: turn.role,
				transcript: turn.transcript
			};
		}
		function parseTurnCreatedEvent(payload) {
			const turn = parseTurnRole(payload);
			return turn === null ? null : {
				type: "turn.created",
				turn
			};
		}
		function parseTurnDeltaEvent(payload) {
			return typeof payload.delta === "string" ? {
				type: "turn.delta",
				delta: payload.delta
			} : null;
		}
		function parseTurnDoneEvent(payload) {
			const turn = parseTurnRole(payload);
			return turn === null ? null : {
				type: "turn.done",
				turn
			};
		}
		function parseDelegationCreatedEvent(payload) {
			const item = payload.item;
			if (!isRecord(item) || item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") return null;
			if (!Array.isArray(item.content)) return null;
			const content = [];
			for (const candidate of item.content) {
				if (!isRecord(candidate) || candidate.type !== "input_text" || typeof candidate.text !== "string") continue;
				content.push({
					type: "input_text",
					text: candidate.text
				});
			}
			return {
				type: "delegation.created",
				item: {
					type: "delegation",
					target: "client",
					id: item.id,
					content
				}
			};
		}
		function stringifyErrorValue(value) {
			if (typeof value === "string") return value;
			if (value === void 0) return null;
			try {
				return JSON.stringify(value) ?? null;
			} catch {
				return String(value);
			}
		}
		function parseErrorEvent(payload) {
			if (typeof payload.message === "string") return {
				type: "error",
				message: payload.message
			};
			const error = payload.error;
			if (isRecord(error) && typeof error.message === "string") return {
				type: "error",
				message: error.message
			};
			const message = stringifyErrorValue(error);
			return message === null ? null : {
				type: "error",
				message
			};
		}
		function parseUsageValue(value) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed.length > 0 ? trimmed : void 0;
			}
		}
		function addUsageMetric(metrics, seen, name, value) {
			const parsed = parseUsageValue(value);
			if (parsed === void 0 || seen.has(name)) return;
			seen.add(name);
			metrics.push({
				name,
				value: parsed
			});
		}
		function addUsageRecord(metrics, seen, record, prefix) {
			for (const [name, value] of Object.entries(record)) {
				const key = prefix === void 0 ? name : `${prefix}.${name}`;
				if (isRecord(value)) {
					for (const [nestedName, nestedValue] of Object.entries(value)) addUsageMetric(metrics, seen, `${key}.${nestedName}`, nestedValue);
					continue;
				}
				addUsageMetric(metrics, seen, key, value);
			}
		}
		function parseUsageMetrics(payload) {
			const metrics = [];
			const seen = /* @__PURE__ */ new Set();
			if (isRecord(payload.usage)) addUsageRecord(metrics, seen, payload.usage);
			if (isRecord(payload.session) && isRecord(payload.session.usage)) addUsageRecord(metrics, seen, payload.session.usage);
			for (const [name, value] of Object.entries(payload)) {
				if (name === "type" || name === "usage" || name === "session" || name === "event_id") continue;
				addUsageMetric(metrics, seen, name, value);
			}
			return metrics;
		}
		function formatLiveUsageMetrics(metrics) {
			return metrics.map((metric) => `${metric.name} ${metric.value}`).join(" · ");
		}
		function parseLiveServerEvent(payload) {
			const parsed = parsePayload(payload);
			if (!parsed || typeof parsed.type !== "string") return null;
			switch (parsed.type) {
				case "session.started":
				case "session.updated": return parseSessionEvent(parsed.type, parsed);
				case "output_audio.delta": return typeof parsed.audio === "string" ? {
					type: parsed.type,
					audio: parsed.audio
				} : null;
				case "input_transcript.added":
				case "output_transcript.added": return parseTranscriptAddedEvent(parsed.type, parsed);
				case "turn.created": return parseTurnCreatedEvent(parsed);
				case "turn.delta": return parseTurnDeltaEvent(parsed);
				case "turn.done": return parseTurnDoneEvent(parsed);
				case "delegation.created": return parseDelegationCreatedEvent(parsed);
				case "session.usage.updated": return {
					type: "session.usage.updated",
					metrics: parseUsageMetrics(parsed)
				};
				case "rate_limits.updated": return {
					type: "rate_limits.updated",
					metrics: parseUsageMetrics(parsed)
				};
				case "error": return parseErrorEvent(parsed);
				default: return {
					type: "unknown",
					wireType: parsed.type
				};
			}
		}
		//#endregion
		//#region src/sdp.ts
		function normalizeSdp(sdp) {
			return sdp.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		}
		/** Codex puts `ufrag` on candidate lines. The value contains `/` and some WebRTC stacks reject the line. Session ice-ufrag already carries the credential. */
		function stripCandidateUfrag(sdp) {
			return sdp.replace(/(^a=candidate:.+?) ufrag \S+/gm, "$1");
		}
		/** Chromium GetLine cannot read the last SDP line unless it ends with LF. */
		function prepareRemoteSdp(sdp) {
			const body = stripCandidateUfrag(normalizeSdp(sdp)).trim();
			return body === "" ? "" : `${body}\n`;
		}
		//#endregion
		//#region src/client/webrtc.ts
		const ICE_GATHER_MS = 8e3;
		const ICE_CONNECT_MS = 12e3;
		const EVENTS_OPEN_MS = 12e3;
		async function createLivePeer(options) {
			const localStream = await captureMicrophone(options.signal);
			let pc;
			const dispose = () => {
				localStream.getTracks().forEach((track) => track.stop());
				pc?.close();
			};
			throwIfAborted(options.signal, dispose);
			const audioTrack = localStream.getAudioTracks()[0];
			if (audioTrack === void 0) {
				dispose();
				throw new Error("Microphone track is missing");
			}
			let captureLabel;
			try {
				captureLabel = await waitForMicCapture(audioTrack, options.signal);
				throwIfAborted(options.signal, dispose);
			} catch (error) {
				dispose();
				throw error;
			}
			audioTrack.enabled = false;
			pc = new RTCPeerConnection({
				bundlePolicy: "max-bundle",
				rtcpMuxPolicy: "require",
				iceCandidatePoolSize: 2,
				iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }]
			});
			const peerConnection = pc;
			const reportTransport = () => {
				if (peerConnection.connectionState === "failed") {
					options.onIceState("failed");
					return;
				}
				options.onIceState(peerConnection.iceConnectionState);
			};
			peerConnection.addEventListener("iceconnectionstatechange", reportTransport);
			peerConnection.addEventListener("connectionstatechange", reportTransport);
			let delivered = false;
			peerConnection.addEventListener("track", (event) => {
				if (event.track.kind !== "audio" || delivered) return;
				delivered = true;
				const stream = event.streams[0] ?? new MediaStream([event.track]);
				options.onRemoteStream(stream);
			});
			const eventsChannel = peerConnection.createDataChannel(LIVE_EVENTS_CHANNEL, { ordered: true });
			eventsChannel.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				options.onControlPayload?.(event.data);
			});
			preferOpus(peerConnection.addTransceiver(audioTrack, {
				direction: "sendrecv",
				streams: [localStream]
			}));
			let offer;
			try {
				offer = await peerConnection.createOffer({
					offerToReceiveAudio: true,
					offerToReceiveVideo: false
				});
				throwIfAborted(options.signal, dispose);
				await peerConnection.setLocalDescription(offer);
				throwIfAborted(options.signal, dispose);
				await waitForIceGathering(peerConnection, options.signal);
				throwIfAborted(options.signal, dispose);
			} catch (error) {
				dispose();
				throw error;
			}
			const sdp = peerConnection.localDescription?.sdp;
			if (!sdp || !sdp.includes("m=audio") || !sdp.includes("m=application")) {
				peerConnection.close();
				localStream.getTracks().forEach((track) => track.stop());
				throw new Error("WebRTC produced an offer without audio or the oai-events data channel");
			}
			return {
				offer: sdp,
				peer: {
					pc: peerConnection,
					localStream,
					eventsChannel,
					captureLabel,
					isMicrophoneUsable() {
						return audioTrack.readyState === "live" && !audioTrack.muted;
					},
					setMuted(value) {
						audioTrack.enabled = !value;
					},
					close() {
						eventsChannel.close();
						localStream.getTracks().forEach((track) => track.stop());
						peerConnection.close();
					}
				}
			};
		}
		async function acceptLiveAnswer(peer, answer) {
			const sdp = prepareRemoteSdp(answer);
			if (!sdp.startsWith("v=")) throw new Error("Codex returned a non-SDP answer");
			if (!sdp.includes("m=application")) throw new Error("Codex returned an SDP answer without the oai-events data channel");
			await peer.pc.setRemoteDescription({
				type: "answer",
				sdp
			});
			await Promise.all([waitForIceConnected(peer.pc), waitForEventsChannel(peer.eventsChannel)]);
		}
		async function captureMicrophone(signal) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const finish = (result) => {
					if (settled) {
						if ("stream" in result) result.stream.getTracks().forEach((track) => track.stop());
						return;
					}
					settled = true;
					window.clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if ("stream" in result) resolve(result.stream);
					else reject(result.error);
				};
				const onAbort = () => {
					finish({ error: /* @__PURE__ */ new Error("Live voice start was cancelled") });
				};
				const timer = window.setTimeout(() => {
					finish({ error: /* @__PURE__ */ new Error("Microphone permission timed out") });
				}, 15e3);
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				navigator.mediaDevices.getUserMedia({ audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: false,
					channelCount: 1
				} }).then((stream) => finish({ stream })).catch((error) => {
					const name = error instanceof DOMException ? error.name : "";
					if (name === "NotAllowedError" || name === "PermissionDeniedError") {
						finish({ error: new MicrophoneAccessError() });
						return;
					}
					finish({ error: error instanceof Error ? error : new Error(String(error)) });
				});
			});
		}
		async function waitForMicCapture(track, signal) {
			const deadline = Date.now() + 4e3;
			while (Date.now() < deadline) {
				if (track.readyState !== "live") throw new Error("Microphone track ended before capture started");
				if (!track.muted) {
					const settings = track.getSettings();
					return track.label || settings.deviceId || "microphone";
				}
				await waitForTrackUnmute(track, signal);
			}
			throw new Error(`麦克风一直处于 muted（${track.readyState}）。系统状态栏没有橙色录音点，Codex 只能收到静音。`);
		}
		function waitForTrackUnmute(track, signal) {
			return new Promise((resolve, reject) => {
				const finish = (error) => {
					window.clearTimeout(timer);
					track.removeEventListener("unmute", onUnmute);
					signal?.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				};
				const timer = window.setTimeout(() => finish(), 80);
				const onUnmute = () => {
					finish();
				};
				const onAbort = () => {
					finish(/* @__PURE__ */ new Error("Live voice start was cancelled"));
				};
				track.addEventListener("unmute", onUnmute, { once: true });
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		function throwIfAborted(signal, dispose) {
			if (!signal?.aborted) return;
			dispose();
			throw new Error("Live voice start was cancelled");
		}
		function preferOpus(transceiver) {
			const capabilities = RTCRtpSender.getCapabilities?.("audio");
			if (capabilities == null || typeof transceiver.setCodecPreferences !== "function") return;
			const opus = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === "audio/opus");
			if (opus.length > 0) transceiver.setCodecPreferences(opus);
		}
		function waitForIceGathering(pc, signal) {
			if (pc.iceGatheringState === "complete") return Promise.resolve();
			return new Promise((resolve, reject) => {
				const finish = (error) => {
					window.clearTimeout(timer);
					pc.removeEventListener("icegatheringstatechange", onGathering);
					pc.removeEventListener("icecandidate", onCandidate);
					signal?.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				};
				const timer = window.setTimeout(finish, ICE_GATHER_MS);
				const onGathering = () => {
					if (pc.iceGatheringState === "complete") finish();
				};
				const onCandidate = (event) => {
					if (event.candidate === null) finish();
				};
				const onAbort = () => {
					finish(/* @__PURE__ */ new Error("Live voice start was cancelled"));
				};
				pc.addEventListener("icegatheringstatechange", onGathering);
				pc.addEventListener("icecandidate", onCandidate);
				if (signal?.aborted) onAbort();
				else {
					signal?.addEventListener("abort", onAbort, { once: true });
					if (pc.iceGatheringState === "complete") finish();
				}
			});
		}
		function waitForIceConnected(pc) {
			if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.connectionState === "connected") return Promise.resolve();
			return new Promise((resolve, reject) => {
				const finish = (error) => {
					window.clearTimeout(timer);
					pc.removeEventListener("iceconnectionstatechange", onState);
					pc.removeEventListener("connectionstatechange", onState);
					if (error) reject(error);
					else resolve();
				};
				const timer = window.setTimeout(() => {
					finish(/* @__PURE__ */ new Error(`WebRTC ICE 未连通（${pc.iceConnectionState}）。控制通道能连上，但语音媒体穿不过当前网络/代理。`));
				}, ICE_CONNECT_MS);
				const onState = () => {
					if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed" || pc.connectionState === "connected") {
						finish();
						return;
					}
					if (pc.iceConnectionState === "failed" || pc.connectionState === "failed") finish(/* @__PURE__ */ new Error("WebRTC ICE failed. Live voice media did not reach Codex."));
				};
				pc.addEventListener("iceconnectionstatechange", onState);
				pc.addEventListener("connectionstatechange", onState);
				onState();
			});
		}
		function waitForEventsChannel(channel) {
			if (channel.readyState === "open") return Promise.resolve();
			return new Promise((resolve, reject) => {
				const finish = (error) => {
					window.clearTimeout(timer);
					channel.removeEventListener("open", onOpen);
					channel.removeEventListener("error", onError);
					if (error) reject(error);
					else resolve();
				};
				const timer = window.setTimeout(() => {
					finish(/* @__PURE__ */ new Error("Codex oai-events 数据通道未打开。ICE 通了也不算通话真正开始。"));
				}, EVENTS_OPEN_MS);
				const onOpen = () => {
					finish();
				};
				const onError = () => {
					finish(/* @__PURE__ */ new Error("Codex oai-events 数据通道失败"));
				};
				channel.addEventListener("open", onOpen);
				channel.addEventListener("error", onError);
				if (channel.readyState === "open") finish();
			});
		}
		//#endregion
		//#region \0dshx-css-module:LivePanel.module.css.mjs
		const css = ".OVF-Xq_root{box-sizing:border-box;align-items:center;gap:6px;display:inline-flex}.OVF-Xq_trigger{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:6px;padding:0 10px 0 8px;font-size:13px;font-weight:500;line-height:20px;transition:background-color .14s,border-color .14s,color .14s,transform .1s;display:inline-flex}.OVF-Xq_trigger:hover:not(:disabled),.OVF-Xq_trigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.OVF-Xq_trigger:active:not(:disabled){transform:scale(.96)}.OVF-Xq_trigger:focus-visible{outline:2px solid var(--dsw-static-deepseek-450);outline-offset:2px}.OVF-Xq_trigger[data-live]{border-color:var(--dsw-alias-button-ghost-active-border);background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-static-deepseek-450)}.OVF-Xq_trigger[data-error]{color:var(--dsw-alias-label-danger,#c0392b)}.OVF-Xq_trigger:disabled{cursor:default;opacity:.55}.OVF-Xq_icon{flex:none;width:16px;height:16px}.OVF-Xq_dot{width:7px;height:7px;box-shadow:0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);background:currentColor;border-radius:50%}.OVF-Xq_trigger[data-dial] .OVF-Xq_dot{animation:1.1s ease-out infinite OVF-Xq_live-dot-pulse}.OVF-Xq_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px));margin:0 auto 8px}.OVF-Xq_bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,720px));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);border-radius:12px;align-items:center;gap:10px;margin:0 auto;padding:8px 10px;font-size:13px;line-height:18px;display:flex}.OVF-Xq_meter{flex:none;align-items:flex-end;gap:2px;height:18px;display:flex}.OVF-Xq_ring{background:var(--dsw-static-deepseek-450);width:16px;height:16px;box-shadow:0 0 0 0 var(--dsw-static-deepseek-450);border-radius:50%;flex:none;animation:1.2s ease-out infinite OVF-Xq_live-ring}@keyframes OVF-Xq_live-ring{0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, transparent)}70%{box-shadow:0 0 0 10px color-mix(in srgb, var(--dsw-static-deepseek-450) 0%, transparent)}to{box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-static-deepseek-450) 0%, transparent)}}@keyframes OVF-Xq_live-dot-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb, currentColor 40%, transparent)}70%{box-shadow:0 0 0 8px color-mix(in srgb, currentColor 0%, transparent)}to{box-shadow:0 0 0 0 color-mix(in srgb, currentColor 0%, transparent)}}@media (prefers-reduced-motion:reduce){.OVF-Xq_ring,.OVF-Xq_trigger[data-dial] .OVF-Xq_dot{animation:none}}.OVF-Xq_meter span{background:var(--dsw-static-deepseek-450);transform-origin:bottom;border-radius:1px;width:3px;transition:height 90ms linear;display:block}.OVF-Xq_copy{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.OVF-Xq_phase{font-weight:600}.OVF-Xq_transcript{min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.OVF-Xq_meta{min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;overflow:hidden}.OVF-Xq_error{color:var(--dsw-alias-label-danger,#c0392b)}.OVF-Xq_actions{flex:none;gap:6px;display:flex}.OVF-Xq_action{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);height:28px;color:inherit;font:inherit;cursor:pointer;background:0 0;border-radius:14px;padding:0 10px;font-size:12px}.OVF-Xq_action:hover,.OVF-Xq_action:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.OVF-Xq_taskPanel{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,720px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);border-radius:12px;margin:6px auto 0;font-size:12px;line-height:18px}.OVF-Xq_taskHeader{border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:baseline;gap:8px;min-width:0;padding:7px 10px;font-weight:600;display:flex}.OVF-Xq_taskBoundary{min-width:0;color:var(--dsw-alias-label-secondary);text-align:right;overflow-wrap:anywhere;font-size:11px;font-weight:400}.OVF-Xq_taskScroll{overscroll-behavior:contain;max-height:min(35vh,280px);padding:6px;overflow:hidden auto}.OVF-Xq_taskCard{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform,transparent);border-radius:9px;min-width:0;padding:8px}.OVF-Xq_taskCard+.OVF-Xq_taskCard{margin-top:6px}.OVF-Xq_taskMeta{justify-content:space-between;align-items:center;gap:8px;min-width:0;display:flex}.OVF-Xq_taskKind{color:var(--dsw-alias-label-secondary)}.OVF-Xq_taskStatus{flex:none;font-weight:600}.OVF-Xq_taskStatus[data-status=failed],.OVF-Xq_taskStatus[data-status=discarded],.OVF-Xq_taskStatus[data-status=blocked],.OVF-Xq_taskStatus[data-status=interrupted],.OVF-Xq_taskStatus[data-status=max-tokens]{color:var(--dsw-alias-label-danger,#c0392b)}.OVF-Xq_taskInput{overflow-wrap:anywhere;white-space:pre-wrap;-webkit-line-clamp:3;-webkit-box-orient:vertical;min-width:0;margin-top:4px;display:-webkit-box;overflow:hidden}.OVF-Xq_taskDisclosure{min-width:0;color:var(--dsw-alias-label-secondary);margin-top:5px}.OVF-Xq_taskDisclosure summary{cursor:pointer;user-select:none;width:fit-content}.OVF-Xq_taskDetails{border-top:1px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere;min-width:0;margin-top:6px;padding-top:6px}.OVF-Xq_taskDetails pre{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-primary);font:inherit;white-space:pre-wrap;word-break:break-word;margin:3px 0 0;overflow-x:auto}.OVF-Xq_taskDetailLabel{margin-top:5px;font-weight:600}@media (width<=480px){.OVF-Xq_bar,.OVF-Xq_taskHeader,.OVF-Xq_taskMeta{flex-wrap:wrap}.OVF-Xq_actions{justify-content:flex-end;width:100%}.OVF-Xq_taskBoundary{text-align:left;width:100%}}.OVF-Xq_settings{max-width:560px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:12px;font-size:13px;line-height:20px;display:flex}.OVF-Xq_settingsBlurb{color:var(--dsw-alias-label-secondary)}.OVF-Xq_settingsRow{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.OVF-Xq_settingsText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:24px;display:flex}.OVF-Xq_settingsTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.OVF-Xq_settingsSelect{background:var(--dsw-alias-bg-module-platform);height:36px;color:inherit;font:inherit;cursor:pointer;border:none;border-radius:18px;padding:0 14px;font-size:14px}.OVF-Xq_say{box-sizing:border-box;border-left:2px solid var(--dsw-alias-border-l2);max-width:min(640px,100%);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary)));white-space:pre-wrap;margin:2px 0 6px;padding-left:10px;font-size:13px;line-height:20px}.OVF-Xq_hear{box-sizing:border-box;background:var(--dsw-specific-bubble);width:fit-content;max-width:min(525px,82%);color:var(--dsw-alias-label-primary);white-space:pre-wrap;border-radius:22px;margin-left:auto;padding:10px 16px;font-size:16px;line-height:24px}.OVF-Xq_recovery{margin-top:6px}.OVF-Xq_recovery .OVF-Xq_actions{flex-wrap:wrap;margin-top:6px}.OVF-Xq_recovery .OVF-Xq_meta{white-space:normal}.OVF-Xq_action:disabled{cursor:default;opacity:.55}";
		const tagId = "dsh-livevoice/LivePanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-livevoice";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var LivePanel_module_css_default = {
			"action": "OVF-Xq_action",
			"actions": "OVF-Xq_actions",
			"bar": "OVF-Xq_bar",
			"copy": "OVF-Xq_copy",
			"dock": "OVF-Xq_dock",
			"dot": "OVF-Xq_dot",
			"error": "OVF-Xq_error",
			"hear": "OVF-Xq_hear",
			"icon": "OVF-Xq_icon",
			"live-dot-pulse": "OVF-Xq_live-dot-pulse",
			"live-ring": "OVF-Xq_live-ring",
			"meta": "OVF-Xq_meta",
			"meter": "OVF-Xq_meter",
			"phase": "OVF-Xq_phase",
			"recovery": "OVF-Xq_recovery",
			"ring": "OVF-Xq_ring",
			"root": "OVF-Xq_root",
			"say": "OVF-Xq_say",
			"settings": "OVF-Xq_settings",
			"settingsBlurb": "OVF-Xq_settingsBlurb",
			"settingsRow": "OVF-Xq_settingsRow",
			"settingsSelect": "OVF-Xq_settingsSelect",
			"settingsText": "OVF-Xq_settingsText",
			"settingsTitle": "OVF-Xq_settingsTitle",
			"taskBoundary": "OVF-Xq_taskBoundary",
			"taskCard": "OVF-Xq_taskCard",
			"taskDetailLabel": "OVF-Xq_taskDetailLabel",
			"taskDetails": "OVF-Xq_taskDetails",
			"taskDisclosure": "OVF-Xq_taskDisclosure",
			"taskHeader": "OVF-Xq_taskHeader",
			"taskInput": "OVF-Xq_taskInput",
			"taskKind": "OVF-Xq_taskKind",
			"taskMeta": "OVF-Xq_taskMeta",
			"taskPanel": "OVF-Xq_taskPanel",
			"taskScroll": "OVF-Xq_taskScroll",
			"taskStatus": "OVF-Xq_taskStatus",
			"transcript": "OVF-Xq_transcript",
			"trigger": "OVF-Xq_trigger"
		};
		//#endregion
		//#region src/client/MicrophoneRecovery.tsx
		async function testMicrophone(signal) {
			const stream = await captureMicrophone(signal);
			try {
				if (!stream.getAudioTracks().some((track) => track.readyState === "live" && !track.muted)) throw new Error("已获准，但麦克风没有提供可用音轨。请检查输入设备。");
			} finally {
				stream.getTracks().forEach((track) => track.stop());
			}
		}
		function MicrophoneRecovery(props) {
			const [notice, setNotice] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const pending = (0, react.useRef)(null);
			(0, react.useEffect)(() => () => {
				pending.current?.abort();
				pending.current = null;
			}, []);
			const mac = /Mac/i.test(navigator.platform);
			const desktop = window.location.protocol === "dsh-app:";
			const missing = desktop && props.hostIssue === "missing-audio-entitlement";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LivePanel_module_css_default.recovery,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: LivePanel_module_css_default.error,
						role: "status",
						children: missing ? "当前 DSH 客户端的签名缺少录音权限声明，macOS 不会弹出授权窗口，设置里也可能没有此 App。需要安装补齐录音权限的客户端；重试或重启无法补齐。" : desktop ? "在系统设置「隐私与安全性 → 麦克风」中查找当前客户端（DSH Studio 或 DeepSeek Harness）。若列表中没有它且从未弹窗，可能是 App 签名缺少录音权限，需要更新 App。" : "请允许当前网站使用麦克风，并检查浏览器的系统麦克风权限。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LivePanel_module_css_default.actions,
						children: [desktop && mac ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: LivePanel_module_css_default.action,
							type: "button",
							onClick: async () => {
								try {
									if (!(await fetch(LIVE_MICROPHONE_SETTINGS_PATH, {
										method: "POST",
										headers: { "x-dsh-livevoice-action": "microphone-settings" }
									})).ok) throw new Error("请手动打开系统设置 → 隐私与安全性 → 麦克风。");
									setNotice("已打开麦克风设置。允许后可点「检测麦克风」。");
								} catch (error) {
									setNotice(error instanceof Error ? error.message : String(error));
								}
							},
							children: "打开麦克风设置"
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: LivePanel_module_css_default.action,
							type: "button",
							disabled: busy || missing,
							onClick: async () => {
								const abort = new AbortController();
								pending.current = abort;
								setBusy(true);
								try {
									await testMicrophone(abort.signal);
									setNotice("麦克风可用，检测已结束。点击「重试」开始通话。");
								} catch (error) {
									setNotice(error instanceof Error ? error.message : String(error));
								} finally {
									if (pending.current === abort) {
										pending.current = null;
										setBusy(false);
									}
								}
							},
							children: busy ? "等待麦克风授权…" : "检测麦克风（不连接模型）"
						})]
					}),
					notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: LivePanel_module_css_default.meta,
						role: "status",
						children: notice
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/dial.ts
		function formatConnectingSubtitle(input) {
			return input.stageLabel === void 0 ? input.wait : `${input.stageLabel} · ${input.elapsed}`;
		}
		//#endregion
		//#region src/client/locales.ts
		const en = {
			"settings.microphone.title": "Microphone permission",
			"settings.microphone.hint": "Check capture locally. No model connection or audio upload; capture stops after the check.",
			"settings.microphone.check": "Check microphone locally",
			"settings.microphone.checking": "Waiting for microphone…",
			"settings.microphone.ready": "Microphone is available. Capture has stopped.",
			"chip": "Live",
			"chip.aria": "Start Codex live voice",
			"chip.ariaActive": "End Codex live voice",
			"phase.idle": "Live voice",
			"phase.connecting": "Dialing…",
			"phase.listening": "Ready — speak now",
			"phase.working": "Working",
			"phase.speaking": "Speaking",
			"phase.muted": "Muted",
			"phase.error": "Live error",
			"action.mute": "Mute microphone",
			"action.unmute": "Unmute microphone",
			"action.end": "End live call",
			"action.start": "Start live call",
			"action.retry": "Try again",
			"hint": "Ctrl+L toggle · Space mute · Esc end",
			"voice": "Voice",
			"status.ready": "Codex OAuth ready",
			"status.missing": "Sign in to ChatGPT Codex first",
			"source.dsh-oauth-login": "via subscription login",
			"source.dsh-llm": "via DSH LLM login",
			"source.codex-cli": "via official Codex CLI",
			"source.none": "no Codex OAuth",
			"status.account": "account …{hint}",
			"status.expired": "token expired — Live will try refresh or the next login",
			"status.duration": "connected {seconds}s",
			"usage.label": "Server usage",
			"usage.empty": "No server usage event yet",
			"media.warning": "Audio path interrupted. Waiting to recover…",
			"error.kind.auth": "Sign-in",
			"error.kind.quota": "Voice or Codex limit",
			"error.kind.forbidden": "Not allowed",
			"error.kind.signaling": "Codex signaling",
			"error.kind.network": "Network",
			"error.kind.session": "DSH session",
			"error.kind.media": "Voice media",
			"error.kind.unknown": "Live error",
			"task.count": "{count} tasks",
			"settings.title": "Live Voice",
			"settings.blurb": "Realtime Codex voice for this DSH session. Signaling uses this machine’s Codex OAuth, not an API key. Browser audio still goes to OpenAI, even on the same LAN.",
			"settings.voice.title": "Live voice",
			"settings.voice.hint": "Applies to the next live call.",
			"settings.account.title": "Codex login Live will use",
			"settings.account.missing": "No Codex OAuth on this machine.",
			"settings.account.hint": "ChatGPT in a browser being Pro does not prove Live is using that account.",
			"dial.mic": "Picking up the mic…",
			"dial.offer": "Opening a line…",
			"dial.codex": "Calling Codex…",
			"dial.media": "Waiting for the other end…",
			"dial.ear": "Media connected. Waiting for Codex service…",
			"dial.wait": "Calling Codex · {seconds}s",
			"dial.elapsed": "{seconds}s",
			"task.list": "Live tasks",
			"task.boundary": "This page/call record only · replies are not verification",
			"task.kind.new": "New request",
			"task.kind.additional": "Additional request",
			"task.status.queued": "Queued",
			"task.status.running": "Worker claimed",
			"task.status.replied": "Worker replied · unverified",
			"task.status.no-reply": "Turn ended · no reply",
			"task.status.cancelled": "Cancelled",
			"task.status.blocked": "Blocked",
			"task.status.interrupted": "Turn interrupted",
			"task.status.max-tokens": "Token limit reached",
			"task.status.discarded": "Discarded by DSH",
			"task.status.failed": "Dispatch failed",
			"task.status.tracking-stopped": "Call ended · follow in session",
			"task.details": "Show actual handoff",
			"task.route": "Route",
			"task.route.followup": "Queued with agent.followup",
			"task.route.steer": "Appended with agent.steer",
			"task.handoff": "Actual handoff",
			"task.error": "Dispatch error"
		};
		const zh = {
			"settings.microphone.title": "麦克风权限",
			"settings.microphone.hint": "仅在本机检查采集，检测后立即停止，不连接模型或上传音频。",
			"settings.microphone.check": "检测麦克风（不连接模型）",
			"settings.microphone.checking": "等待麦克风授权…",
			"settings.microphone.ready": "麦克风可用，采集已停止。",
			"chip": "语音",
			"chip.aria": "开始 Codex 实时语音",
			"chip.ariaActive": "结束 Codex 实时语音",
			"phase.idle": "实时语音",
			"phase.connecting": "正在拨号…",
			"phase.listening": "已就绪，可以说话",
			"phase.working": "正在干活",
			"phase.speaking": "正在说",
			"phase.muted": "已静音",
			"phase.error": "语音出错",
			"action.mute": "静音麦克风",
			"action.unmute": "取消静音",
			"action.end": "结束通话",
			"action.start": "开始通话",
			"action.retry": "重试",
			"hint": "Ctrl+L 开关 · 空格静音 · Esc 结束",
			"voice": "声线",
			"status.ready": "Codex OAuth 已就绪",
			"status.missing": "请先登录 ChatGPT Codex",
			"source.dsh-oauth-login": "来自订阅登录",
			"source.dsh-llm": "来自 DSH LLM 登录",
			"source.codex-cli": "来自官方 Codex CLI",
			"source.none": "没有 Codex OAuth",
			"status.account": "账号 …{hint}",
			"status.expired": "令牌已过期 — Live 会尝试刷新或改用下一份登录",
			"status.duration": "已接通 {seconds}秒",
			"usage.label": "服务端用量",
			"usage.empty": "还没有服务端用量事件",
			"media.warning": "音频路径中断，正在等待恢复…",
			"error.kind.auth": "登录/凭据",
			"error.kind.quota": "语音或 Codex 限额",
			"error.kind.forbidden": "没有权限",
			"error.kind.signaling": "Codex 信令",
			"error.kind.network": "网络",
			"error.kind.session": "DSH 会话",
			"error.kind.media": "语音媒体",
			"error.kind.unknown": "语音错误",
			"task.count": "{count} 个任务",
			"settings.title": "实时语音",
			"settings.blurb": "把 Codex 实时语音接到当前 DSH 会话。信令用这台机器上的 Codex OAuth，不是 API Key。浏览器音频仍直连 OpenAI，同一局域网也不例外。",
			"settings.voice.title": "Live 声线",
			"settings.voice.hint": "下一通实时语音生效。",
			"settings.account.title": "Live 将使用的 Codex 登录",
			"settings.account.missing": "这台机器上没有 Codex OAuth。",
			"settings.account.hint": "浏览器里 ChatGPT 是 Pro，并不能证明 Live 读到的是同一个账号。",
			"dial.mic": "正在拿起麦克风…",
			"dial.offer": "正在接通线路…",
			"dial.codex": "正在拨通 Codex…",
			"dial.media": "正在等待对方接听…",
			"dial.ear": "媒体已接通，正在等待 Codex 服务就绪…",
			"dial.wait": "正在拨号 · {seconds}秒",
			"dial.elapsed": "{seconds}秒",
			"task.list": "实时任务",
			"task.boundary": "仅当前页面/通话记录 · Worker 回复不代表验收通过",
			"task.kind.new": "新请求",
			"task.kind.additional": "追加请求",
			"task.status.queued": "已排队",
			"task.status.running": "Worker 已接手",
			"task.status.replied": "Worker 已回复 · 未验收",
			"task.status.no-reply": "本轮结束 · 未回复",
			"task.status.cancelled": "已取消",
			"task.status.blocked": "已阻塞",
			"task.status.interrupted": "本轮已中断",
			"task.status.max-tokens": "已到 Token 上限",
			"task.status.discarded": "DSH 已丢弃",
			"task.status.failed": "派发失败",
			"task.status.tracking-stopped": "通话已结束 · 后续见会话",
			"task.details": "查看实际派工",
			"task.route": "路由",
			"task.route.followup": "通过 agent.followup 排队",
			"task.route.steer": "通过 agent.steer 追加",
			"task.handoff": "实际 handoff",
			"task.error": "派发错误"
		};
		function isLiveVoiceKey(value) {
			return Object.hasOwn(en, value);
		}
		//#endregion
		//#region src/client/levels.ts
		function rmsFromAnalyser(analyser, buffer) {
			analyser.getByteTimeDomainData(buffer);
			if (buffer.length === 0) return 0;
			let sumSquares = 0;
			for (let index = 0; index < buffer.length; index += 1) {
				const sample = ((buffer[index] ?? 128) - 128) / 128;
				sumSquares += sample * sample;
			}
			return Math.min(1, Math.sqrt(sumSquares / buffer.length));
		}
		function smoothLevel(previous, next, attack = .35, release = .12) {
			const alpha = next > previous ? attack : release;
			return previous + (next - previous) * alpha;
		}
		const METER_FLOOR = .012;
		function meterHeights(input) {
			const energy = Math.sqrt(Math.max(0, Math.min(1, input)));
			if (input < METER_FLOOR) return [
				0,
				0,
				0,
				0,
				0,
				0,
				0
			];
			return [
				.22,
				.4,
				.7,
				1,
				.7,
				.4,
				.22
			].map((weight) => {
				return Math.max(8, Math.round(energy * weight * 100));
			});
		}
		function createLevelMonitor(stream, onLevel) {
			const context = new AudioContext({ latencyHint: "interactive" });
			const source = context.createMediaStreamSource(stream);
			const analyser = context.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = .7;
			source.connect(analyser);
			const buffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
			let frame = 0;
			let smoothed = 0;
			let lastEmit = 0;
			const tick = (now) => {
				smoothed = smoothLevel(smoothed, rmsFromAnalyser(analyser, buffer));
				if (now - lastEmit >= 80) {
					lastEmit = now;
					onLevel(smoothed);
				}
				frame = window.requestAnimationFrame(tick);
			};
			frame = window.requestAnimationFrame(tick);
			context.resume();
			return () => {
				window.cancelAnimationFrame(frame);
				source.disconnect();
				if (context.state !== "closed") context.close();
			};
		}
		//#endregion
		//#region src/client/LiveChip.tsx
		function LiveChip(props) {
			const live = props.liveOf(String(props.sessionId));
			const [state, setState] = (0, react.useState)(live.snapshot);
			(0, react.useEffect)(() => live.subscribe(setState), [live]);
			(0, react.useEffect)(() => {
				live.refreshStatus();
			}, [live]);
			const active = state.phase !== "idle";
			const label = active ? props.t("chip.ariaActive") : props.t("chip.aria");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LivePanel_module_css_default.root,
				"data-live-voice-chip": "",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: LivePanel_module_css_default.trigger,
						"data-live": active ? "" : void 0,
						"data-dial": state.phase === "connecting" ? "" : void 0,
						"data-error": state.phase === "error" || state.error ? "" : void 0,
						"aria-pressed": active,
						"aria-label": label,
						onClick: () => {
							live.toggle();
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LiveGlyph, { active }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("chip") })]
					})
				})
			});
		}
		function LiveDock(props) {
			const live = props.liveOf(String(props.sessionId));
			const [state, setState] = (0, react.useState)(live.snapshot);
			const [, setTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => live.subscribe(setState), [live]);
			(0, react.useEffect)(() => {
				if (state.phase !== "connecting" && state.connectedAt === void 0) return;
				const timer = window.setInterval(() => setTick((value) => value + 1), 1e3);
				return () => window.clearInterval(timer);
			}, [
				state.phase,
				state.dialStartedAt,
				state.connectedAt
			]);
			const bars = (0, react.useMemo)(() => meterHeights(state.inputLevel), [state.inputLevel]);
			const phaseKey = `phase.${state.phase}`;
			const connecting = state.phase === "connecting";
			const showBar = state.phase !== "idle" || Boolean(state.error);
			if (!showBar && state.receipts.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: LivePanel_module_css_default.dock,
				"data-live-voice-dock": "",
				children: [showBar ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LivePanel_module_css_default.bar,
					tabIndex: 0,
					"data-live-voice-bar": "",
					"data-phase": state.phase,
					onPointerDown: () => live.retryPlayback(),
					children: [
						connecting ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: LivePanel_module_css_default.ring,
							"aria-hidden": "true"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: LivePanel_module_css_default.meter,
							"aria-hidden": "true",
							children: bars.map((height, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { height: `${height}%` } }, index))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: LivePanel_module_css_default.copy,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.phase,
									children: props.t(phaseKey)
								}),
								state.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.error,
									children: errorLine(state, props.t)
								}) : connecting ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.transcript,
									children: connectingSubtitle(state, props.t)
								}) : state.transcript ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.transcript,
									children: state.transcript.text
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.transcript,
									children: stageLabel(state.stage, props.t) ?? (state.capture ? `麦克风 ${state.capture}` : props.t("hint"))
								}),
								state.microphoneBlocked ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MicrophoneRecovery, { hostIssue: state.status?.microphone }) : null,
								callMeta(state, props.t) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: LivePanel_module_css_default.meta,
									children: callMeta(state, props.t)
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: LivePanel_module_css_default.actions,
							onPointerDown: (event) => event.stopPropagation(),
							children: [state.phase !== "idle" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: LivePanel_module_css_default.action,
								onClick: () => live.toggleMute(),
								children: props.t(state.muted ? "action.unmute" : "action.mute")
							}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: LivePanel_module_css_default.action,
								onClick: () => {
									live.toggle();
								},
								children: props.t(state.phase === "idle" ? state.error ? "action.retry" : "action.start" : "action.end")
							})]
						})
					]
				}) : null, state.receipts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskReceiptList, {
					receipts: state.receipts,
					t: props.t
				}) : null]
			});
		}
		function TaskReceiptList(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: LivePanel_module_css_default.taskPanel,
				"data-live-task-list": "",
				"aria-label": props.t("task.list"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LivePanel_module_css_default.taskHeader,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						props.t("task.list"),
						" · ",
						props.t("task.count", { count: props.receipts.length })
					] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: LivePanel_module_css_default.taskBoundary,
						children: props.t("task.boundary")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: LivePanel_module_css_default.taskScroll,
					children: [...props.receipts].reverse().map((receipt) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						className: LivePanel_module_css_default.taskCard,
						"data-live-task-receipt": "",
						"data-receipt-id": receipt.id,
						"data-request-kind": receipt.requestKind,
						"data-route": receipt.route,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: LivePanel_module_css_default.taskMeta,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LivePanel_module_css_default.taskKind,
									children: props.t(receipt.requestKind === "new" ? "task.kind.new" : "task.kind.additional")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: LivePanel_module_css_default.taskStatus,
									"data-live-task-status": receipt.status,
									"data-status": receipt.status,
									children: props.t(taskStatusKey(receipt.status))
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.taskInput,
								"data-live-task-input": "",
								children: receipt.input
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								className: LivePanel_module_css_default.taskDisclosure,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
									"data-live-task-toggle": "",
									children: props.t("task.details")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: LivePanel_module_css_default.taskDetails,
									"data-live-task-details": "",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: LivePanel_module_css_default.taskDetailLabel,
											children: props.t("task.route")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: props.t(receipt.route === "steer" ? "task.route.steer" : "task.route.followup") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: LivePanel_module_css_default.taskDetailLabel,
											children: props.t("task.handoff")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
											"data-live-task-handoff": "",
											children: receipt.handoff
										}),
										receipt.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: LivePanel_module_css_default.taskDetailLabel,
											children: props.t("task.error")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: receipt.error })] }) : null
									]
								})]
							})
						]
					}, receipt.id))
				})]
			});
		}
		function taskStatusKey(status) {
			return `task.status.${status}`;
		}
		function LiveGlyph(props) {
			if (props.active) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: LivePanel_module_css_default.dot });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: LivePanel_module_css_default.icon,
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fill: "currentColor",
					d: "M8 1.75a2.25 2.25 0 0 0-2.25 2.25v3a2.25 2.25 0 1 0 4.5 0v-3A2.25 2.25 0 0 0 8 1.75Zm-3.75 5.5a.75.75 0 0 0-1.5 0 5.25 5.25 0 0 0 4.5 5.196V14h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.554A5.25 5.25 0 0 0 13.25 7.25a.75.75 0 0 0-1.5 0 3.75 3.75 0 1 1-7.5 0Z"
				})
			});
		}
		function stageLabel(stage, t) {
			if (stage === void 0) return void 0;
			return isLiveVoiceKey(stage) ? t(stage) : stage;
		}
		function errorLine(state, t) {
			const message = state.error ?? "";
			if (state.errorKind === void 0) return message;
			const key = `error.kind.${state.errorKind}`;
			return isLiveVoiceKey(key) ? `${t(key)}: ${message}` : message;
		}
		function callMeta(state, t) {
			const parts = [];
			if (state.status && state.status.source !== "none") {
				const sourceKey = `source.${state.status.source}`;
				if (isLiveVoiceKey(sourceKey)) parts.push(t(sourceKey));
			}
			if (state.status?.accountHint) parts.push(t("status.account", { hint: state.status.accountHint }));
			if (state.status?.expired) parts.push(t("status.expired"));
			if (state.connectedAt !== void 0 && state.phase !== "idle") {
				const seconds = Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1e3));
				parts.push(t("status.duration", { seconds }));
			}
			if (state.usageMetrics !== void 0 && state.usageMetrics.length > 0) parts.push(`${t("usage.label")}: ${formatLiveUsageMetrics(state.usageMetrics)}`);
			if (state.mediaWarning !== void 0) parts.push(isLiveVoiceKey(state.mediaWarning) ? t(state.mediaWarning) : state.mediaWarning);
			return parts.length > 0 ? parts.join(" · ") : void 0;
		}
		function connectingSubtitle(state, t) {
			const seconds = Math.max(0, Math.floor((Date.now() - (state.dialStartedAt ?? Date.now())) / 1e3));
			return formatConnectingSubtitle({
				stageLabel: stageLabel(state.stage, t),
				wait: t("dial.wait", { seconds }),
				elapsed: t("dial.elapsed", { seconds })
			});
		}
		//#endregion
		//#region src/voices.ts
		const LIVE_VOICE_OPTIONS = [
			{
				value: "arbor",
				label: "Arbor"
			},
			{
				value: "breeze",
				label: "Breeze"
			},
			{
				value: "cove",
				label: "Cove"
			},
			{
				value: "ember",
				label: "Ember"
			},
			{
				value: "juniper",
				label: "Juniper"
			},
			{
				value: "maple",
				label: "Maple"
			},
			{
				value: "sol",
				label: "Sol"
			},
			{
				value: "spruce",
				label: "Spruce"
			},
			{
				value: "vale",
				label: "Vale"
			}
		];
		const LIVE_VOICE_VALUES = LIVE_VOICE_OPTIONS.map(({ value }) => value);
		function isLiveVoice(value) {
			return LIVE_VOICE_VALUES.includes(value);
		}
		function resolveLiveVoice(value) {
			const trimmed = value?.trim() ?? "";
			return isLiveVoice(trimmed) ? trimmed : "sol";
		}
		//#endregion
		//#region src/kinds.ts
		const LIVE_FAILURE_KINDS = [
			"auth",
			"quota",
			"forbidden",
			"signaling",
			"network",
			"session",
			"media",
			"unknown"
		];
		function isLiveFailureKind(value) {
			return LIVE_FAILURE_KINDS.includes(value);
		}
		//#endregion
		//#region src/client/api.ts
		var LiveCallError = class extends Error {
			kind;
			upstreamStatus;
			constructor(message, kind = "unknown", upstreamStatus) {
				super(message);
				this.name = "LiveCallError";
				this.kind = kind;
				this.upstreamStatus = upstreamStatus;
			}
		};
		function liveErrorFromBody(parsed, status, fallback) {
			if (typeof parsed !== "object" || parsed === null) return new LiveCallError(fallback, status === 401 ? "auth" : "unknown", status);
			const record = parsed;
			return new LiveCallError(typeof record.error === "string" && record.error.length > 0 ? record.error : fallback, typeof record.kind === "string" && isLiveFailureKind(record.kind) ? record.kind : status === 401 ? "auth" : status === 403 ? "forbidden" : status === 429 ? "quota" : status === 409 ? "session" : "unknown", typeof record.upstreamStatus === "number" ? record.upstreamStatus : status);
		}
		async function readJson(response) {
			const text = await response.text();
			const parsed = text.length === 0 ? {} : JSON.parse(text);
			if (!response.ok) throw liveErrorFromBody(parsed, response.status, `Live voice request failed (${response.status})`);
			return parsed;
		}
		async function fetchLiveStatus() {
			return readJson(await fetch(LIVE_STATUS_PATH));
		}
		async function fetchWithTimeout(url, init, timeoutMs) {
			const abort = new AbortController();
			const timer = window.setTimeout(() => abort.abort(), timeoutMs);
			try {
				return await fetch(url, {
					...init,
					signal: abort.signal,
					credentials: "same-origin"
				});
			} catch (error) {
				if (abort.signal.aborted) throw new LiveCallError(`Live voice request timed out after ${Math.round(timeoutMs / 1e3)}s`, "network");
				throw error;
			} finally {
				window.clearTimeout(timer);
			}
		}
		async function startLiveCall(input) {
			return readJson(await fetchWithTimeout(LIVE_CALLS_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: input.sessionId,
					sdp: input.sdp,
					voice: input.voice
				})
			}, 4e4));
		}
		async function stopLiveCall(callToken) {
			await readJson(await fetch(LIVE_STOP_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callToken })
			}));
		}
		function subscribeLiveEvents(callToken, onEvent) {
			const source = new EventSource(`${LIVE_EVENTS_PATH}?call=${encodeURIComponent(callToken)}`);
			let terminalReported = false;
			const handle = (message) => {
				if (!(message instanceof MessageEvent) || typeof message.data !== "string") return;
				try {
					onEvent(JSON.parse(message.data));
				} catch {}
			};
			const handleSourceError = (event) => {
				if (event instanceof MessageEvent) {
					handle(event);
					return;
				}
				if (terminalReported || source.readyState !== EventSource.CLOSED) return;
				terminalReported = true;
				source.close();
				onEvent({
					type: "error",
					message: "Live voice call ended or was replaced. Try again.",
					kind: "network"
				});
			};
			source.addEventListener("phase", handle);
			source.addEventListener("ready", handle);
			source.addEventListener("transcript", handle);
			source.addEventListener("task-receipt", handle);
			source.addEventListener("usage", handle);
			source.addEventListener("error", handleSourceError);
			source.addEventListener("closed", handle);
			return () => {
				source.close();
			};
		}
		//#endregion
		//#region src/client/playback.ts
		const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
		function applyRemotePlayback(audio, stream) {
			audio.srcObject = stream;
			audio.muted = false;
			audio.volume = 1;
			audio.autoplay = true;
		}
		/** Must run inside the user-gesture continuation that started the call. */
		function unlockPlayback() {
			const audio = new Audio();
			audio.autoplay = true;
			audio.setAttribute("playsinline", "");
			audio.muted = false;
			audio.volume = 1;
			audio.src = SILENT_WAV;
			document.body.appendChild(audio);
			audio.play().catch(() => {});
			let stopped = false;
			let remote;
			let context;
			let graph;
			const fallbackContext = () => {
				context ??= new AudioContext();
				return context;
			};
			const playRemote = (stream) => {
				if (stopped) return;
				remote = stream;
				applyRemotePlayback(audio, stream);
				audio.play().catch(async () => {
					if (stopped) return;
					const audioContext = fallbackContext();
					if (audioContext.state === "suspended") await audioContext.resume();
					graph?.disconnect();
					const source = audioContext.createMediaStreamSource(stream);
					source.connect(audioContext.destination);
					graph = source;
				});
			};
			return {
				attach: playRemote,
				retry() {
					if (remote) playRemote(remote);
					else fallbackContext().resume();
				},
				stop() {
					stopped = true;
					graph?.disconnect();
					graph = void 0;
					remote = void 0;
					audio.pause();
					audio.srcObject = null;
					audio.removeAttribute("src");
					audio.remove();
					if (context && context.state !== "closed") context.close();
				}
			};
		}
		//#endregion
		//#region src/receipts.ts
		const MAX_RECENT_SETTLED_RECEIPTS = 24;
		function isActive(status) {
			return status === "queued" || status === "running";
		}
		function mergeLiveTaskReceipt(receipts, incoming) {
			const next = receipts.filter((receipt) => receipt.id !== incoming.id);
			next.push(incoming);
			next.sort((left, right) => left.createdAt - right.createdAt);
			const settled = next.filter((receipt) => !isActive(receipt.status));
			const remove = new Set(settled.sort((left, right) => left.updatedAt - right.updatedAt).slice(0, Math.max(0, settled.length - MAX_RECENT_SETTLED_RECEIPTS)).map((receipt) => receipt.id));
			return next.filter((receipt) => !remove.has(receipt.id));
		}
		function stopTrackingLiveTaskReceipts(receipts, now = Date.now()) {
			return receipts.map((receipt) => isActive(receipt.status) ? {
				...receipt,
				status: "tracking-stopped",
				updatedAt: now
			} : receipt);
		}
		//#endregion
		//#region src/client/session.ts
		const VOICE_KEY = "dsh-livevoice.voice";
		const voiceHub = /* @__PURE__ */ new Set();
		function storedLiveVoice() {
			return loadVoice();
		}
		function subscribeStoredVoice(listener) {
			voiceHub.add(listener);
			return () => {
				voiceHub.delete(listener);
			};
		}
		function chooseStoredVoice(voice) {
			saveVoice(voice);
			for (const listener of voiceHub) listener();
		}
		var LiveClientSession = class {
			sessionId;
			listeners = /* @__PURE__ */ new Set();
			peer;
			playback;
			remoteStream;
			stopEvents;
			stopInputLevels;
			callToken;
			startAbort;
			starting = false;
			startGen = 0;
			sessionProofReady = false;
			pendingPhase;
			sessionProofWaiter;
			state = {
				phase: "idle",
				muted: false,
				inputLevel: 0,
				outputLevel: 0,
				voice: loadVoice(),
				receipts: []
			};
			constructor(sessionId) {
				this.sessionId = sessionId;
				subscribeStoredVoice(() => {
					const next = loadVoice();
					if (next === this.state.voice) return;
					if (this.state.phase !== "idle" || this.starting) return;
					this.patch({ voice: next });
				});
			}
			get snapshot() {
				return this.state;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				listener(this.state);
				return () => {
					this.listeners.delete(listener);
				};
			}
			async refreshStatus(expectedGen) {
				try {
					const status = await fetchLiveStatus();
					if (expectedGen !== void 0 && expectedGen !== this.startGen) return;
					this.patch({
						status,
						voice: resolveLiveVoice(this.state.voice || status.defaultVoice)
					});
				} catch (error) {
					if (expectedGen !== void 0 && expectedGen !== this.startGen) return;
					this.patch({
						status: {
							ready: false,
							source: "none",
							voices: [],
							defaultVoice: "sol"
						},
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
			setVoice(voice) {
				saveVoice(voice);
				this.patch({ voice });
			}
			async switchVoice(voice) {
				const previous = this.state.voice;
				this.setVoice(voice);
				if (voice === previous) return;
				if (this.state.phase === "idle" && !this.starting) return;
				await this.stop();
				await this.start();
			}
			async toggle() {
				if (this.state.phase !== "idle") {
					await this.stop();
					return;
				}
				await this.start();
			}
			retryPlayback() {
				this.playback?.retry();
			}
			toggleMute() {
				if (this.state.phase === "idle") return;
				const muted = !this.state.muted;
				this.peer?.setMuted(this.starting ? true : muted);
				this.patch({
					muted,
					phase: this.state.phase === "connecting" ? "connecting" : muted ? "muted" : this.state.phase === "muted" ? "listening" : this.state.phase,
					inputLevel: muted ? 0 : this.state.inputLevel
				});
			}
			async start() {
				if (this.state.phase !== "idle") return;
				const gen = ++this.startGen;
				const abort = new AbortController();
				this.startAbort = abort;
				this.starting = true;
				this.sessionProofReady = false;
				this.pendingPhase = void 0;
				this.patch({
					phase: "connecting",
					stage: "dial.mic",
					dialStartedAt: Date.now(),
					error: void 0,
					microphoneBlocked: false,
					transcript: void 0,
					voice: loadVoice()
				});
				const playback = unlockPlayback();
				this.playback = playback;
				try {
					if (this.state.status?.ready !== true) await this.refreshStatus(gen);
					if (gen !== this.startGen) return;
					if (this.state.status?.ready !== true) throw new LiveCallError(this.state.status ? "No Codex OAuth credential is available. Sign in to ChatGPT Codex first." : "Live voice status is unavailable.", "auth");
					this.patch({ stage: "dial.offer" });
					const created = await createLivePeer({
						onRemoteStream: (stream) => {
							if (gen !== this.startGen) {
								stream.getTracks().forEach((track) => track.stop());
								return;
							}
							this.remoteStream = stream;
							playback.attach(stream);
						},
						onIceState: (iceState) => {
							if (gen !== this.startGen) return;
							if (this.state.phase === "connecting" || this.starting) {
								this.patch({ stage: "dial.media" });
								return;
							}
							if (iceState === "connected" || iceState === "completed") {
								if (this.state.mediaWarning) this.patch({ mediaWarning: void 0 });
								return;
							}
							if (iceState === "disconnected") {
								this.patch({ mediaWarning: "media.warning" });
								return;
							}
							if (iceState === "failed" || iceState === "closed") this.stop("Live voice media dropped after the call was up. This is the browser audio path to OpenAI, not a Codex quota error.", "media");
						},
						onControlPayload: (payload) => {
							if (gen === this.startGen) this.applyControlPayload(payload);
						},
						signal: abort.signal
					});
					if (gen !== this.startGen) {
						created.peer.close();
						return;
					}
					this.peer = created.peer;
					created.peer.setMuted(true);
					this.patch({ capture: created.peer.captureLabel });
					this.stopInputLevels = createLevelMonitor(created.peer.localStream, (level) => {
						if (gen !== this.startGen) return;
						if (this.state.muted) {
							if (this.state.inputLevel !== 0) this.patch({ inputLevel: 0 });
							return;
						}
						if (Math.abs(level - this.state.inputLevel) < .02) return;
						this.patch({ inputLevel: level });
					});
					this.patch({ stage: "dial.codex" });
					const call = await startLiveCall({
						sessionId: this.sessionId,
						sdp: created.offer,
						voice: this.state.voice
					});
					if (gen !== this.startGen) {
						try {
							await stopLiveCall(call.callToken);
						} catch {}
						return;
					}
					this.callToken = call.callToken;
					this.stopEvents = subscribeLiveEvents(call.callToken, (event) => {
						if (gen === this.startGen) this.handleEvent(event);
					});
					this.patch({ stage: "dial.media" });
					await acceptLiveAnswer(created.peer, call.answer);
					if (gen !== this.startGen) return;
					this.trace("ice+oai-events");
					this.patch({ stage: "dial.ear" });
					await this.waitForSessionProof(2e4);
					if (gen !== this.startGen || !this.peer) return;
					if (!created.peer.isMicrophoneUsable()) throw new Error("Microphone capture ended before the live session became ready.");
					created.peer.setMuted(this.state.muted);
					const pendingPhase = this.pendingPhase;
					this.pendingPhase = void 0;
					this.patch({
						phase: this.state.muted ? "muted" : pendingPhase && pendingPhase !== "connecting" ? pendingPhase : "listening",
						stage: void 0,
						dialStartedAt: void 0,
						connectedAt: Date.now()
					});
				} catch (error) {
					if (gen !== this.startGen || this.state.phase === "idle") return;
					this.patch({ microphoneBlocked: error instanceof MicrophoneAccessError });
					await this.stop(error instanceof Error ? error.message : String(error), liveFailureKind(error));
				} finally {
					if (this.startAbort === abort) this.startAbort = void 0;
					if (gen === this.startGen) this.starting = false;
				}
			}
			async stop(error, kind) {
				this.startGen += 1;
				this.starting = false;
				this.startAbort?.abort();
				this.startAbort = void 0;
				this.rejectSessionProof(/* @__PURE__ */ new Error("Live voice start was cancelled"));
				this.sessionProofReady = false;
				this.pendingPhase = void 0;
				const callToken = this.callToken;
				this.callToken = void 0;
				this.stopEvents?.();
				this.stopEvents = void 0;
				this.stopInputLevels?.();
				this.stopInputLevels = void 0;
				this.playback?.stop();
				this.playback = void 0;
				this.remoteStream = void 0;
				this.peer?.close();
				this.peer = void 0;
				this.patch({
					phase: "idle",
					stage: void 0,
					dialStartedAt: void 0,
					connectedAt: void 0,
					muted: false,
					inputLevel: 0,
					outputLevel: 0,
					capture: void 0,
					mediaWarning: void 0,
					usageSource: void 0,
					usageMetrics: void 0,
					receipts: stopTrackingLiveTaskReceipts(this.state.receipts),
					...error === void 0 ? {
						error: this.state.error,
						errorKind: this.state.errorKind
					} : {
						error,
						errorKind: kind
					}
				});
				if (callToken) try {
					await stopLiveCall(callToken);
				} catch {}
			}
			applyControlPayload(payload) {
				const event = parseLiveServerEvent(payload);
				if (event?.type === "session.started" || event?.type === "session.updated") this.markSessionProofReady();
				if (event?.type === "error") this.handleEvent({
					type: "error",
					message: event.message
				});
			}
			handleEvent(event) {
				if (event.type === "ready") {
					this.markSessionProofReady();
					return;
				}
				if (event.type === "phase") {
					if (this.starting) {
						this.pendingPhase = event.phase;
						return;
					}
					const phase = this.state.muted ? "muted" : event.phase;
					this.patch({
						phase,
						...event.phase === "listening" || event.phase === "speaking" || event.phase === "working" || event.phase === "error" ? {
							stage: void 0,
							dialStartedAt: void 0
						} : {}
					});
					return;
				}
				if (event.type === "transcript") {
					this.patch({
						transcript: event.transcript ? {
							role: event.transcript.role,
							text: event.transcript.text,
							final: event.transcript.final
						} : void 0,
						...this.starting ? {} : { stage: void 0 }
					});
					return;
				}
				if (event.type === "task-receipt") {
					this.patch({ receipts: mergeLiveTaskReceipt(this.state.receipts, event.receipt) });
					return;
				}
				if (event.type === "usage") {
					this.patch({
						usageSource: event.source,
						usageMetrics: event.metrics
					});
					return;
				}
				if (event.type === "error") {
					this.stop(event.message, event.kind);
					return;
				}
				if (event.type === "closed") this.stop();
			}
			waitForSessionProof(ms) {
				if (this.sessionProofReady) return Promise.resolve();
				return new Promise((resolve, reject) => {
					const timer = window.setTimeout(() => {
						this.sessionProofWaiter = void 0;
						reject(/* @__PURE__ */ new Error("Codex live session did not become ready within 20 seconds."));
					}, ms);
					this.sessionProofWaiter = {
						resolve,
						reject,
						timer
					};
				});
			}
			markSessionProofReady() {
				if (!this.sessionProofReady) this.trace("session-proof");
				this.sessionProofReady = true;
				const waiter = this.sessionProofWaiter;
				if (!waiter) return;
				window.clearTimeout(waiter.timer);
				this.sessionProofWaiter = void 0;
				waiter.resolve();
			}
			rejectSessionProof(error) {
				const waiter = this.sessionProofWaiter;
				if (!waiter) return;
				window.clearTimeout(waiter.timer);
				this.sessionProofWaiter = void 0;
				waiter.reject(error);
			}
			trace(label) {
				const started = this.state.dialStartedAt;
				const elapsed = started === void 0 ? 0 : Date.now() - started;
				console.log(`[dsh-livevoice] +${elapsed}ms ${label}`);
			}
			patch(patch) {
				this.state = {
					...this.state,
					...patch
				};
				for (const listener of this.listeners) listener(this.state);
			}
		};
		function liveFailureKind(error) {
			if (typeof error !== "object" || error === null || !("kind" in error)) return "unknown";
			const kind = error.kind;
			return typeof kind === "string" && isLiveFailureKind(kind) ? kind : "unknown";
		}
		function loadVoice() {
			try {
				return resolveLiveVoice(window.localStorage.getItem(VOICE_KEY) ?? void 0);
			} catch {
				return "sol";
			}
		}
		function saveVoice(voice) {
			try {
				window.localStorage.setItem(VOICE_KEY, voice);
			} catch {}
		}
		//#endregion
		//#region src/client/LiveSettings.tsx
		function LiveVoiceSettings(props) {
			const [voice, setVoice] = (0, react.useState)(storedLiveVoice);
			const [status, setStatus] = (0, react.useState)();
			const [microphoneNotice, setMicrophoneNotice] = (0, react.useState)("");
			const [checkingMicrophone, setCheckingMicrophone] = (0, react.useState)(false);
			const microphoneRequest = (0, react.useRef)(null);
			(0, react.useEffect)(() => () => {
				microphoneRequest.current?.abort();
				microphoneRequest.current = null;
			}, []);
			(0, react.useEffect)(() => subscribeStoredVoice(() => {
				setVoice(storedLiveVoice());
			}), []);
			(0, react.useEffect)(() => {
				fetchLiveStatus().then(setStatus).catch(() => setStatus(void 0));
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: LivePanel_module_css_default.settingsRow,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LivePanel_module_css_default.settingsText,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsTitle,
								children: props.t("settings.account.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsBlurb,
								children: accountSummary(status, props.t)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsBlurb,
								children: props.t("settings.account.hint")
							})
						]
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LivePanel_module_css_default.settingsRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LivePanel_module_css_default.settingsText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: LivePanel_module_css_default.settingsTitle,
							children: props.t("settings.voice.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: LivePanel_module_css_default.settingsBlurb,
							children: props.t("settings.voice.hint")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						"aria-label": props.t("voice"),
						className: LivePanel_module_css_default.settingsSelect,
						value: voice,
						onChange: (event) => {
							chooseStoredVoice(resolveLiveVoice(event.target.value));
						},
						children: LIVE_VOICE_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option.value,
							children: option.label
						}, option.value))
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: LivePanel_module_css_default.settingsRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: LivePanel_module_css_default.settingsText,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsTitle,
								children: props.t("settings.microphone.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsBlurb,
								children: props.t("settings.microphone.hint")
							}),
							microphoneNotice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: LivePanel_module_css_default.settingsBlurb,
								role: "status",
								children: microphoneNotice
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: LivePanel_module_css_default.action,
						type: "button",
						disabled: checkingMicrophone,
						onClick: async () => {
							const request = new AbortController();
							microphoneRequest.current = request;
							setCheckingMicrophone(true);
							setMicrophoneNotice("");
							try {
								await testMicrophone(request.signal);
								if (!request.signal.aborted) setMicrophoneNotice(props.t("settings.microphone.ready"));
							} catch (error) {
								if (!request.signal.aborted) setMicrophoneNotice(error instanceof Error ? error.message : String(error));
							} finally {
								if (microphoneRequest.current === request) {
									microphoneRequest.current = null;
									setCheckingMicrophone(false);
								}
							}
						},
						children: props.t(checkingMicrophone ? "settings.microphone.checking" : "settings.microphone.check")
					})]
				})
			] });
		}
		function accountSummary(status, t) {
			if (status === void 0) return t("settings.account.hint");
			if (status.source === "none") return t("settings.account.missing");
			const sourceKey = `source.${status.source}`;
			const parts = [
				isLiveVoiceKey(sourceKey) ? t(sourceKey) : void 0,
				status.accountHint ? t("status.account", { hint: status.accountHint }) : void 0,
				status.expired ? t("status.expired") : void 0
			].filter((part) => part !== void 0);
			return parts.length > 0 ? parts.join(" · ") : t("settings.account.hint");
		}
		//#endregion
		//#region src/client/LiveHear.tsx
		function LiveHear(props) {
			const text = props.node.outcome?.text ?? props.node.args ?? "";
			if (!text) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LivePanel_module_css_default.hear,
				"data-live-voice-hear": "",
				children: text
			});
		}
		//#endregion
		//#region src/client/LiveSay.tsx
		function LiveSay(props) {
			const text = props.node.outcome?.text ?? props.node.args ?? "";
			if (!text) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: LivePanel_module_css_default.say,
				"data-live-voice-say": "",
				children: text
			});
		}
		//#endregion
		//#region src/client/index.tsx
		const NS = "liveVoice";
		const sessions = /* @__PURE__ */ new Map();
		const name = "dsh-livevoice-client";
		const inject = ["slots", "locale"];
		function sessionOf(sessionId) {
			const id = String(sessionId);
			const existing = sessions.get(id);
			if (existing) return existing;
			const created = new LiveClientSession(id);
			sessions.set(id, created);
			return created;
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-livevoice: dictionaries");
			ctx.effect(() => {
				const onKey = (event) => {
					const live = [...sessions.values()].find((item) => item.snapshot.phase !== "idle");
					if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l" && !event.altKey) {
						const sessionId = currentSessionId();
						if (!sessionId) return;
						event.preventDefault();
						sessionOf(sessionId).toggle();
						return;
					}
					if (!live) return;
					if (event.key === "Escape") {
						event.preventDefault();
						live.toggle();
						return;
					}
					if (event.key === " " && !isTypingTarget(event.target)) {
						if (!(document.activeElement?.closest("[data-live-voice-bar=\"\"]") !== null)) return;
						event.preventDefault();
						live.toggleMute();
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, "dsh-livevoice: keys");
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "dsh-livevoice",
				order: 35,
				locale: NS
			}, LiveVoiceSettings));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "live",
				order: 30,
				label: () => ctx.locale.bind(NS)("chip"),
				locale: NS,
				inject: () => ({ liveOf: sessionOf })
			}, LiveChip));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "live",
				order: 20,
				priority: -80,
				locale: NS,
				inject: () => ({ liveOf: sessionOf })
			}, LiveDock));
			ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
				name: "conversation.chat.commandview",
				key: LIVE_SAY_COMMAND,
				locale: NS
			}, LiveSay));
			ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
				name: "conversation.chat.commandview",
				key: LIVE_HEAR_COMMAND,
				locale: NS
			}, LiveHear));
		}
		function currentSessionId() {
			const match = window.location.pathname.match(/\/sessions\/([^/]+)/);
			if (match?.[1]) return decodeURIComponent(match[1]);
			const fromDom = document.querySelector("[data-session-id]")?.getAttribute("data-session-id");
			if (fromDom) return fromDom;
			return sessions.keys().next().value;
		}
		function isTypingTarget(target) {
			if (!(target instanceof HTMLElement)) return false;
			return target.closest("input, textarea, [contenteditable=\"true\"]") !== null;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map