export const VIDEO_JOB_STATES = [
  "CREATED",
  "PREPARING",
  "SUBMITTING",
  "QUEUED",
  "GENERATING",
  "PROCESSING",
  "GENERATED",
  "RETRIEVING",
  "VALIDATING",
  "POST_PROCESSING",
  "QUALITY_CHECKING",
  "COMPLETED",
  "AUTH_REQUIRED",
  "UI_CHANGED",
  "SUBMISSION_FAILED",
  "GENERATION_FAILED",
  "TIMEOUT",
  "DOWNLOAD_FAILED",
  "INVALID_OUTPUT",
  "QUALITY_REJECTED",
  "POSTPROCESS_FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
] as const;

export type VideoJobState = (typeof VIDEO_JOB_STATES)[number];

export type VideoJobPriority = "LOW" | "NORMAL" | "HIGH";

/**
 * Flow exposes different clip lengths by model. These are the lengths
 * documented for Gemini Omni Flash; the UI adapter verifies availability
 * before it submits a paid render.
 */
export const FLOW_VIDEO_DURATIONS = ["4s", "6s", "8s", "10s"] as const;
export type FlowVideoDuration = (typeof FLOW_VIDEO_DURATIONS)[number];

export const FLOW_VIDEO_MODELS = [
  "gemini-omni-flash",
  "veo-3.1-fast",
  "veo-3.1-quality",
] as const;
export type FlowVideoModel = (typeof FLOW_VIDEO_MODELS)[number];

/** Google Flow's multiple image-reference mode. */
export type FlowReferenceMode = "ingredients";

export interface OutputSpec {
  duration: FlowVideoDuration;
  aspectRatio: FlowAspectRatio;
  useCase?: string;
}

export interface CameraBrief {
  shotType?: string;
  composition?: string;
  position?: string;
  movement?: string;
  lensFeeling?: string;
  locked?: boolean;
}

export interface CreativeBrief {
  subject: Record<string, string>;
  scene: Record<string, string>;
  action: Record<string, string>;
  camera: CameraBrief;
  lighting: Record<string, string>;
  composition: Record<string, string>;
  style: Record<string, string>;
  motion: Record<string, string>;
  audio: Record<string, string>;
  continuity: Record<string, string>;
  constraints: string[];
  negativeConstraints: string[];
  output: OutputSpec;
  sourceInstruction: string;
}

export interface CompiledPrompt {
  text: string;
  negativePrompt?: string;
  constraintsApplied: string[];
}

export interface JobEvent {
  at: string;
  stage: VideoJobState;
  event: string;
  details?: Record<string, unknown>;
}

/** Result of the post-generation watermark-removal stage, recorded on the job. */
export interface WatermarkOutcome {
  removed: boolean;
  method?: "unblend" | "inpaint" | "delogo";
  durationMs?: number;
  registerScore?: number;
  alphaMean?: number;
  skipped?: boolean;
  error?: string;
}

export interface QualityCheck {
  name: string;
  status: "PASS" | "FAIL" | "NOT_EVALUATED";
  severity: "INFO" | "MINOR" | "MAJOR" | "CRITICAL";
  details?: Record<string, unknown>;
}

export interface QualityReport {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  scorecard: {
    technicalIntegrity: "PASS" | "FAIL" | "NOT_EVALUATED";
    promptAdherence: "PASS" | "FAIL" | "NOT_EVALUATED";
    visualCoherence: "PASS" | "FAIL" | "NOT_EVALUATED";
    motionQuality: "PASS" | "FAIL" | "NOT_EVALUATED";
    cameraAccuracy: "PASS" | "FAIL" | "NOT_EVALUATED";
    audioIntegrity: "PASS" | "FAIL" | "NOT_EVALUATED";
  };
  checks: QualityCheck[];
  metadata?: VideoMetadata;
}

export interface VideoMetadata {
  container?: string;
  bytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  frameCount?: number;
  hasAudio?: boolean;
}

export interface VideoJob {
  id: string;
  idempotencyKey?: string;
  parentJobId?: string;
  state: VideoJobState;
  priority: VideoJobPriority;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastProgressAt?: string;
  request: {
    instruction: string;
    duration?: FlowVideoDuration;
    model?: FlowVideoModel;
    aspectRatio: FlowAspectRatio;
    qualityTarget: "standard" | "high";
    referenceImagePaths: string[];
    referenceMode?: FlowReferenceMode;
    kind?: FlowRenderKind;
    outputCount?: number;
  };
  creativeBrief?: CreativeBrief;
  compiledPrompt?: CompiledPrompt;
  provider?: "google-flow-browser";
  providerReference?: string;
  attempts: {
    submission: number;
    generation: number;
    retrieval: number;
    uiRecovery: number;
  };
  output?: {
    rootDir: string;
    finalPath?: string;
    sourceUrl?: string;
    watermark?: WatermarkOutcome;
  };
  quality?: QualityReport;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  cancellationRequested?: boolean;
  events: JobEvent[];
}

export type FlowRenderKind = "video" | "image";
export type FlowAspectRatio = "16:9" | "9:16" | "1:1" | "3:4" | "4:3";

export interface GenerationRequest {
  instruction: string;
  /** Image renders ignore duration. */
  duration?: FlowVideoDuration;
  model?: FlowVideoModel;
  aspectRatio: FlowAspectRatio;
  priority?: VideoJobPriority;
  idempotencyKey?: string;
  qualityTarget?: "standard" | "high";
  /** Absolute local image files deliberately selected by the caller. */
  referenceImagePaths?: string[];
  /** Multiple image references are attached as Google Flow Ingredients. */
  referenceMode?: FlowReferenceMode;
  parentJobId?: string;
  priorBrief?: CreativeBrief;
  /** Defaults to "video". */
  kind?: FlowRenderKind;
  /** Image mode only: how many variations Flow renders (1-4). */
  outputCount?: number;
}

export interface ProviderSubmission {
  reference: string;
}

export type ProviderGenerationState =
  | "QUEUED"
  | "GENERATING"
  | "GENERATED"
  | "FAILED"
  | "UNKNOWN";

export interface ProviderObservation {
  state: ProviderGenerationState;
  progressSignature?: string;
  message?: string;
  assetUrl?: string;
}

export interface AssetRetrievalResult {
  stagedPath: string;
  sourceUrl?: string;
}
