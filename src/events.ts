import type { LiveFailureKind } from './kinds.js'
import type { LivePhase, LiveUsageMetric, LiveUsageSource } from './protocol.js'
import type { LiveTaskReceipt } from './receipts.js'
import type { LiveTranscript } from './transcript.js'

export type LiveUiEvent =
  | { type: 'ready' }
  | { type: 'playback'; enabled: boolean }
  | { type: 'phase'; phase: LivePhase }
  | { type: 'transcript'; transcript: LiveTranscript | undefined }
  | { type: 'task-receipt'; receipt: LiveTaskReceipt }
  | { type: 'usage'; source: LiveUsageSource; metrics: readonly LiveUsageMetric[] }
  | { type: 'error'; message: string; kind?: LiveFailureKind }
  | { type: 'closed' }
