# Speech input stall investigation

## Confirmed application deadlock

The direct-transcript patch at `93a8eca` ignored every `delegation.created`
event and forwarded only a user `turn.done`. A real Frameless Bidi call
produced this sequence:

1. User ASR arrives as `input_transcript.added`, `turn.created`, and `turn.delta`.
2. `delegation.created` requests a backend handoff.
3. The service waits for a backend response before sending the user `turn.done`.

With a synthetic Japanese utterance lasting 12.45 seconds, speech ended at
16.072 seconds, delegation arrived at 17.203 seconds, and **no backend input
was dispatched before the test closed at 93.018 seconds**.

The first fix used the delegation as a boundary, forwarding the original ASR
after 750 ms of settling. The same utterance reached the fixture backend
1.903 seconds after speech ended. Only after its response did the service emit
the user final. The Sol voice read the exact fixture response:
`音声はバックエンドに届きました。`

Delegation text is model-written and remains excluded from backend input.
No new backend prompt or conversation wrapper is introduced.

## Short replies and event ordering

A short `Aかな` also produced raw ASR without either a delegation or final.
The client now observes microphone energy: after speech followed by 1.8 seconds
of silence, the server can forward settled ASR independently of model judgment.
Without a delegation, ASR gets a longer 1.5-second settling window because a
live test delivered adjacent transcript fragments about one second apart.
New speech cancels the pending silence handoff.

Buffers and timers belong to individual upstream turn IDs, including the
`user_bidi_turn_id` on delegation events. A sent-text cursor prevents duplicate
delivery and retains later words if one upstream turn spans multiple acoustic
utterances. Tests cover adjacent turns, delayed finals, early delegation,
ASR preceding an empty created event, repeated words, stale activity requests,
resumed speech, and shutdown.

The selected voice and backend readout mechanism remain unchanged. Device
capture ending is now surfaced as a retryable error.

## Separate media transport problem observed

Later synthetic calls sometimes returned corrupted ASR or no ASR at all.
One call's browser `getStats()` reported:

| Time in call | Outbound RTP packets sent | Remote-reported packets lost |
| --- | ---: | ---: |
| 28.514 s | 1,178 | 470 |
| 40.509 s | 1,778 | 677 |

Across those observations, 600 additional packets were sent and the remote
loss counter increased by 207 (about 35%). Remote reports can lag sender
counters, so this is approximate. This is evidence of media-path trouble,
separate from the reproducible application deadlock. It does not identify
the failing network hop.

The silence fallback can deliver available ASR; it cannot recover audio that
the recognition service never received or transcribed. Fixing the application
deadlock does not establish that the media transport issue is resolved.

## Validation

`npm test` exercises input buffering, microphone activity, HTTP validation,
device lifecycle, transcript display and backend readout. `npm run build`
checks TypeScript and rebuilds the distributed client/server bundles.

Live probes used synthetic audio and a fixture backend, not a user's task
execution. OAuth credentials were kept local and were not written into the
probe results or this report.
