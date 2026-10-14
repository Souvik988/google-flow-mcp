import { VideoSystemError } from "./errors.js";
import type { VideoJobState } from "./types.js";

const terminalStates = new Set<VideoJobState>([
  "COMPLETED",
  "GENERATION_FAILED",
  "TIMEOUT",
  "DOWNLOAD_FAILED",
  "INVALID_OUTPUT",
  "QUALITY_REJECTED",
  "POSTPROCESS_FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
  "AUTH_REQUIRED",
  "UI_CHANGED",
  "SUBMISSION_FAILED",
]);

const allowedTransitions: Record<VideoJobState, VideoJobState[]> = {
  CREATED: ["PREPARING", "CANCELLED"],
  PREPARING: ["SUBMITTING", "AUTH_REQUIRED", "CANCELLED", "SUBMISSION_FAILED"],
  SUBMITTING: ["QUEUED", "AUTH_REQUIRED", "UI_CHANGED", "SUBMISSION_FAILED", "CANCELLED"],
  QUEUED: ["GENERATING", "GENERATED", "GENERATION_FAILED", "TIMEOUT", "CANCELLED"],
  GENERATING: ["PROCESSING", "GENERATED", "GENERATION_FAILED", "TIMEOUT", "CANCELLED"],
  PROCESSING: ["GENERATED", "GENERATION_FAILED", "TIMEOUT", "CANCELLED"],
  // Retrieval can fail before the RETRIEVING transition is recorded: Flow
  // finished (credits spent) but the asset never became downloadable, and
  // leaving GENERATED non-terminal stranded the job with no retry path.
  GENERATED: ["RETRIEVING", "DOWNLOAD_FAILED", "GENERATION_FAILED", "CANCELLED"],
  RETRIEVING: ["VALIDATING", "DOWNLOAD_FAILED", "CANCELLED"],
  VALIDATING: ["POST_PROCESSING", "QUALITY_CHECKING", "INVALID_OUTPUT", "CANCELLED"],
  POST_PROCESSING: ["QUALITY_CHECKING", "POSTPROCESS_FAILED", "CANCELLED"],
  // The pipeline re-enters POST_PROCESSING (watermark removal) after the
  // technical QC and returns to QUALITY_CHECKING for the cleaned-file check.
  // RETRIEVING is the operator-recovery exit; GENERATION_FAILED lets a stuck
  // QC record its failure instead of freezing.
  QUALITY_CHECKING: ["COMPLETED", "QUALITY_REJECTED", "PREPARING", "POST_PROCESSING", "RETRIEVING", "GENERATION_FAILED", "CANCELLED"],
  COMPLETED: [],
  AUTH_REQUIRED: [],
  UI_CHANGED: [],
  SUBMISSION_FAILED: [],
  TIMEOUT: [],
  // Operator recovery (recover_video_job / recovery-main) may resume retrieval
  // when a render finished and the asset is already staged or still reachable
  // in Flow. Automation never retries these on its own.
  DOWNLOAD_FAILED: ["RETRIEVING"],
  GENERATION_FAILED: ["RETRIEVING"],
  INVALID_OUTPUT: [],
  QUALITY_REJECTED: [],
  POSTPROCESS_FAILED: [],
  CANCELLED: [],
  // Deliberately not fully terminal: automation never touches it, but the
  // operator recovery path (recover_video_job / recovery-main) resumes
  // retrieval for jobs parked here after a crash or a stranded download.
  RECOVERY_REQUIRED: ["RETRIEVING"],
};

export function isTerminalState(state: VideoJobState): boolean {
  return terminalStates.has(state);
}

export function assertTransition(from: VideoJobState, to: VideoJobState): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new VideoSystemError(
      "INTERNAL_ERROR",
      `Invalid job transition from ${from} to ${to}.`,
      { details: { from, to } },
    );
  }
}
