import path from "path";
import { z } from "zod";
import { VideoSystemError } from "./errors.js";
import { FLOW_VIDEO_MODELS, type FlowVideoModel } from "./types.js";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

/** Like booleanFromEnvironment, but an unset variable keeps the fallback. */
const booleanFromEnvironmentWithDefault = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === "true"));

const positiveInteger = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? Number.parseInt(value, 10) : fallback))
    .refine((value) => Number.isInteger(value) && value > 0, "must be a positive integer");

const environmentSchema = z.object({
  FLOW_STUDIO_URL: z.string().url().optional(),
  FLOW_OUTPUT_DIR: z.string().optional(),
  FLOW_STATE_DIR: z.string().optional(),
  FLOW_BROWSER_PROFILE_DIR: z.string().optional(),
  FLOW_BROWSER_CDP_URL: z.string().url().optional(),
  FLOW_BROWSER_EXECUTABLE_PATH: z.string().optional(),
  PUPPETEER_USER_DATA_DIR: z.string().optional(),
  PUPPETEER_HEADLESS: booleanFromEnvironment,
  FLOW_MAX_CONCURRENCY: positiveInteger(1),
  FLOW_GENERATION_TIMEOUT_MS: positiveInteger(12 * 60 * 1000),
  FLOW_PROGRESS_STALL_MS: positiveInteger(90 * 1000),
  FLOW_INITIAL_POLL_MS: positiveInteger(2_000),
  FLOW_MAX_POLL_MS: positiveInteger(15_000),
  FLOW_MAX_SUBMISSION_RETRIES: positiveInteger(3),
  FLOW_MAX_GENERATION_ATTEMPTS: positiveInteger(2),
  FLOW_CAPTURE_DIAGNOSTICS: booleanFromEnvironment,
  FFPROBE_PATH: z.string().optional(),
  FLOW_BROWSER_LAUNCH_TIMEOUT_MS: positiveInteger(45_000),
  FLOW_HTTP_HOST: z.string().optional(),
  FLOW_HTTP_PORT: positiveInteger(4318),
  FLOW_HTTP_TOKEN: z.string().min(24).optional(),
  FLOW_TRANSPORT: z.enum(["stdio", "http", "both"]).optional(),
  FLOW_DEFAULT_VIDEO_MODEL: z.enum(FLOW_VIDEO_MODELS).optional(),
  FLOW_WATERMARK_REMOVAL: booleanFromEnvironmentWithDefault(true),
  FLOW_WATERMARK_METHOD: z.enum(["auto", "unblend", "inpaint", "ffmpeg"]).optional(),
  FLOW_WATERMARK_SCRIPT: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),
  PYTHON_PATH: z.string().optional(),
});

export interface VideoSystemConfig {
  workspaceRoot: string;
  flowStudioUrl: string;
  outputDir: string;
  stateDir: string;
  browserProfileDir: string;
  browserCdpUrl?: string;
  browserExecutablePath?: string;
  headless: boolean;
  maxConcurrency: number;
  generationTimeoutMs: number;
  progressStallMs: number;
  initialPollMs: number;
  maxPollMs: number;
  maxSubmissionRetries: number;
  maxGenerationAttempts: number;
  captureDiagnostics: boolean;
  ffprobePath?: string;
  browserLaunchTimeoutMs: number;
  httpHost: string;
  httpPort: number;
  httpToken?: string;
  transport: "stdio" | "http" | "both";
  defaultVideoModel: FlowVideoModel;
  /** Remove the Veo sparkle watermark from every finished clip before delivery. */
  watermarkRemoval: boolean;
  watermarkMethod: "auto" | "unblend" | "inpaint" | "ffmpeg";
  watermarkScriptPath?: string;
  ffmpegPath?: string;
  pythonPath?: string;
}

function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  const resolved = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VideoSystemError(
      "PATH_VALIDATION_FAILED",
      "Video-system paths must stay inside the configured workspace.",
    );
  }
  return resolved;
}

function defaultBrowserProfilePath(workspaceRoot: string, environment: NodeJS.ProcessEnv): string {
  // Never implicitly reuse a workspace Chrome profile: it may be open in an
  // interactive browser and would corrupt or block the automation session.
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, "GoogleFlowMcp", "browser-profile");
  return path.join(workspaceRoot, ".flow-browser-profile");
}

function resolveBrowserProfilePath(workspaceRoot: string, candidate: string | undefined, environment: NodeJS.ProcessEnv): string {
  if (!candidate) return defaultBrowserProfilePath(workspaceRoot, environment);
  return path.isAbsolute(candidate) ? path.normalize(candidate) : resolveWorkspacePath(workspaceRoot, candidate);
}

export function loadVideoSystemConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workspaceRoot = process.cwd(),
): VideoSystemConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new VideoSystemError("CONFIGURATION_ERROR", "Invalid video system configuration.", {
      details: { issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  const env = parsed.data;
  const root = path.resolve(workspaceRoot);
  const flowStudioUrl = env.FLOW_STUDIO_URL ?? "https://flow.google.com/";
  const parsedFlowUrl = new URL(flowStudioUrl);
  const trustedFlowHost = isTrustedFlowHost(parsedFlowUrl.hostname);
  if (parsedFlowUrl.protocol !== "https:" || !trustedFlowHost) {
    throw new VideoSystemError(
      "CONFIGURATION_ERROR",
      "FLOW_STUDIO_URL must be an HTTPS Google-owned URL.",
    );
  }
  if (env.FLOW_BROWSER_CDP_URL) {
    const cdpUrl = new URL(env.FLOW_BROWSER_CDP_URL);
    if (cdpUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(cdpUrl.hostname)) {
      throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_BROWSER_CDP_URL must be a loopback HTTP URL.");
    }
  }

  return {
    workspaceRoot: root,
    flowStudioUrl,
    outputDir: resolveWorkspacePath(root, env.FLOW_OUTPUT_DIR ?? "outputs"),
    stateDir: resolveWorkspacePath(root, env.FLOW_STATE_DIR ?? ".flow-state"),
    browserProfileDir: resolveBrowserProfilePath(root, env.FLOW_BROWSER_PROFILE_DIR ?? env.PUPPETEER_USER_DATA_DIR, environment),
    browserCdpUrl: env.FLOW_BROWSER_CDP_URL,
    browserExecutablePath: env.FLOW_BROWSER_EXECUTABLE_PATH,
    headless: env.PUPPETEER_HEADLESS,
    maxConcurrency: env.FLOW_MAX_CONCURRENCY,
    generationTimeoutMs: env.FLOW_GENERATION_TIMEOUT_MS,
    progressStallMs: env.FLOW_PROGRESS_STALL_MS,
    initialPollMs: env.FLOW_INITIAL_POLL_MS,
    maxPollMs: env.FLOW_MAX_POLL_MS,
    maxSubmissionRetries: env.FLOW_MAX_SUBMISSION_RETRIES,
    maxGenerationAttempts: env.FLOW_MAX_GENERATION_ATTEMPTS,
    captureDiagnostics: env.FLOW_CAPTURE_DIAGNOSTICS,
    ffprobePath: env.FFPROBE_PATH,
    browserLaunchTimeoutMs: env.FLOW_BROWSER_LAUNCH_TIMEOUT_MS,
    httpHost: env.FLOW_HTTP_HOST ?? "127.0.0.1",
    httpPort: env.FLOW_HTTP_PORT,
    httpToken: env.FLOW_HTTP_TOKEN,
    transport: env.FLOW_TRANSPORT ?? "stdio",
    defaultVideoModel: env.FLOW_DEFAULT_VIDEO_MODEL ?? "gemini-omni-flash",
    watermarkRemoval: env.FLOW_WATERMARK_REMOVAL,
    watermarkMethod: env.FLOW_WATERMARK_METHOD ?? "auto",
    watermarkScriptPath: env.FLOW_WATERMARK_SCRIPT,
    ffmpegPath: env.FFMPEG_PATH,
    pythonPath: env.PYTHON_PATH,
  };
}

export function isTrustedFlowHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "google.com" ||
    normalized.endsWith(".google.com") ||
    normalized === "labs.google" ||
    normalized.endsWith(".labs.google")
  );
}

export function assertPathInside(basePath: string, candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(basePath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new VideoSystemError("PATH_VALIDATION_FAILED", "Requested file path is outside the allowed output directory.");
  }
  return resolved;
}
