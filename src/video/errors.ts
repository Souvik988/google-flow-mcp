export type VideoErrorCode =
  | "AUTH_REQUIRED"
  | "FLOW_UI_CHANGED"
  | "SELECTOR_RESOLUTION_FAILED"
  | "SUBMISSION_FAILED"
  | "GENERATION_TIMEOUT"
  | "GENERATION_REJECTED"
  | "BROWSER_DISCONNECTED"
  | "DOWNLOAD_FAILED"
  | "FILE_VALIDATION_FAILED"
  | "QUALITY_CONTROL_FAILED"
  | "POST_PROCESSING_FAILED"
  | "RECOVERY_REQUIRED"
  | "CANCELLED"
  | "CONFIGURATION_ERROR"
  | "PATH_VALIDATION_FAILED"
  | "INTERNAL_ERROR";

export class VideoSystemError extends Error {
  readonly code: VideoErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: VideoErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "VideoSystemError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function asVideoSystemError(error: unknown): VideoSystemError {
  if (error instanceof VideoSystemError) return error;
  return new VideoSystemError(
    "INTERNAL_ERROR",
    sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    { retryable: false, cause: error },
  );
}

/** Keeps client and log messages useful without leaking credential-like text. */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(password|passwd|secret|token|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, "[URL_WITH_QUERY_REDACTED]");
}
