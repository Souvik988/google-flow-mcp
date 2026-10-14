import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoSystemError } from "./errors.js";
import { logger } from "../utils.js";

/** Veo clips and Flow images carry the Gemini sparkle badge bottom-right. */
export type WatermarkMethod = "unblend" | "inpaint" | "delogo";

export interface WatermarkRemovalResult {
  outputPath: string;
  method: WatermarkMethod;
  durationMs: number;
  /** Telemetry from the engine report (WMV2_REPORT line), when available. */
  registerScore?: number;
  alphaMean?: number;
}

export interface WatermarkRemovalOptions {
  outputPath: string;
  aspect: "16:9" | "9:16" | "1:1" | "3:4" | "4:3";
  /** Still images use the same engines in single-frame mode. */
  kind?: "video" | "image";
  /** auto = registered unblending → OpenCV inpainting → ffmpeg delogo. */
  method?: "auto" | WatermarkMethod | "ffmpeg";
  pythonPath?: string;
  ffmpegPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
  /** Test seam: replaces child-process launching. */
  run?: ProcessRunner;
}

export type ProcessRunner = (binary: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface DelogoRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Watermark box in frame fractions, mirroring scripts/remove_watermark.py so
 * the ffmpeg fallback targets the same region. Portrait frames swap the axes.
 */
export function delogoRegionFor(frameWidth: number, frameHeight: number, aspect: "16:9" | "9:16" | "1:1" | "3:4" | "4:3"): DelogoRegion {
  const landscape = aspect === "16:9" || aspect === "4:3" || (aspect !== "9:16" && aspect !== "3:4" && frameHeight <= frameWidth);
  const xRatio = landscape ? 1120 / 1280 : 575 / 720;
  const yRatio = landscape ? 560 / 720 : 1135 / 1280;
  const wRatio = landscape ? 80 / 1280 : 80 / 720;
  const hRatio = landscape ? 85 / 720 : 85 / 1280;

  // delogo needs the box strictly inside the frame so the filter can sample
  // border pixels; clamp with a 2px guard band on every side.
  const x = Math.max(2, Math.min(Math.round(frameWidth * xRatio), frameWidth - 4));
  const y = Math.max(2, Math.min(Math.round(frameHeight * yRatio), frameHeight - 4));
  const w = Math.max(2, Math.min(Math.round(frameWidth * wRatio), frameWidth - x - 2));
  const h = Math.max(2, Math.min(Math.round(frameHeight * hRatio), frameHeight - y - 2));
  return { x, y, w, h };
}

/** Locates a watermark script for both tsx (src/) and node (dist/) runs. */
export function findWatermarkScript(name = "remove_watermark.py", explicitPath?: string): string | undefined {
  if (explicitPath) return fsSync.existsSync(explicitPath) ? explicitPath : undefined;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "..", "..", "scripts", name),
    path.resolve(currentDir, "..", "..", "..", "scripts", name),
    path.resolve(process.cwd(), "scripts", name),
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

interface RunResult {
  code: number | null;
  stderrTail: string;
  stdoutTail: string;
}

function runProcess(binary: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    let stdoutTail = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new VideoSystemError("POST_PROCESSING_FAILED", `${path.basename(binary)} timed out after ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-2_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderrTail, stdoutTail });
    });
  });
}

interface PythonEngineSpec {
  method: Extract<WatermarkMethod, "unblend" | "inpaint">;
  script: string;
}

async function removeWithPython(
  spec: PythonEngineSpec,
  input: string,
  output: string,
  options: WatermarkRemovalOptions,
  timeoutMs: number,
  run: ProcessRunner,
): Promise<RunResult> {
  const candidates = options.pythonPath
    ? [options.pythonPath]
    : process.platform === "win32"
      ? ["python"]
      : ["python3", "python"];
  const args = [spec.script, "--input", input, "--output", output, "--quiet"];
  if (options.kind === "image") {
    args.push("--image");
  } else if (options.aspect === "16:9" || options.aspect === "9:16") {
    args.push("--aspect", options.aspect);
  }

  let lastError = "python was not found";
  for (const python of candidates) {
    try {
      const result = await run(python, args, timeoutMs);
      if (result.code === 0 && (await fileIsUsable(output))) return result;
      lastError = `python exited ${result.code}${result.stderrTail ? `: ${result.stderrTail.split("\n").slice(-3).join(" ").trim()}` : ""}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new VideoSystemError("POST_PROCESSING_FAILED", `${spec.method} watermark removal failed: ${lastError}`);
}

/** Extracts the WMV2_REPORT telemetry line from the v3 engine's stdout. */
export function parseEngineReport(stdoutTail: string): { registerScore?: number; alphaMean?: number; engineMethod?: string } {
  const match = /WMV2_REPORT\s+(\{.*\})/.exec(stdoutTail);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]) as { register_score?: number; alpha_mean?: number; method?: string };
    return { registerScore: parsed.register_score, alphaMean: parsed.alpha_mean, engineMethod: parsed.method };
  } catch {
    return {};
  }
}

async function removeWithDelogo(
  input: string,
  output: string,
  options: WatermarkRemovalOptions,
  timeoutMs: number,
  run: ProcessRunner,
): Promise<void> {
  if (!options.ffmpegPath) {
    throw new VideoSystemError("POST_PROCESSING_FAILED", "FFmpeg is not configured (set FFMPEG_PATH) for delogo watermark removal.");
  }
  const metadata = await probeFrameSize(options.ffmpegPath, input, timeoutMs, run).catch(() => undefined);
  if (!metadata) {
    throw new VideoSystemError("POST_PROCESSING_FAILED", "Could not read the video frame size for delogo watermark removal.");
  }
  const region = delogoRegionFor(metadata.width, metadata.height, options.aspect);
  const partial = `${output}.part.mp4`;
  // Audio is remuxed when the codec survives re-encoding the video stream, and
  // re-encoded as stereo AAC otherwise (the Python engine makes the same choice).
  const attempts: string[][] = [
    ["-c:a", "copy"],
    ["-c:a", "aac", "-b:a", "192k"],
  ];
  let lastStderr = "";
  for (const audioFlags of attempts) {
    const result = await run(
      options.ffmpegPath,
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", input,
        "-vf", `delogo=x=${region.x}:y=${region.y}:w=${region.w}:h=${region.h}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
        ...audioFlags,
        "-movflags", "+faststart",
        partial,
      ],
      timeoutMs,
    );
    if (result.code === 0 && (await fileIsUsable(partial))) {
      await fs.rename(partial, output);
      return;
    }
    lastStderr = result.stderrTail;
    await fs.rm(partial, { force: true }).catch(() => undefined);
  }
  throw new VideoSystemError("POST_PROCESSING_FAILED", `ffmpeg delogo failed: ${lastStderr.split("\n").slice(-3).join(" ").trim()}`);
}

async function probeFrameSize(
  ffmpegPath: string,
  input: string,
  timeoutMs: number,
  run: ProcessRunner,
): Promise<{ width: number; height: number }> {
  // ffprobe may not sit next to every ffmpeg install; derive the frame size
  // from ffmpeg's own stderr banner instead of requiring a second binary.
  const result = await run(ffmpegPath, ["-hide_banner", "-i", input], Math.min(timeoutMs, 30_000));
  const match = /Stream #\d+:\d+.*Video:.*?, (\d{2,5})x(\d{2,5})/.exec(result.stderrTail);
  if (!match) {
    throw new VideoSystemError("POST_PROCESSING_FAILED", "Could not determine the video frame size (ffmpeg reported no video stream).");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    throw new VideoSystemError("POST_PROCESSING_FAILED", "ffmpeg reported an invalid frame size.");
  }
  return { width, height };
}

async function fileIsUsable(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 4_096);
}

/**
 * Removes the Veo/Gemini sparkle from a finished render. Engine order:
 * forced method, or auto = registered alpha-unblending (v3: reconstructs the
 * pixels under the semi-transparent badge — no smudge, no rectangle, no
 * flicker), then OpenCV Navier-Stokes inpainting, then the ffmpeg delogo
 * fallback. Throws only when every configured method fails; callers deliver
 * the untouched original in that case.
 */
export async function removeWatermarkFromVideo(
  input: string,
  options: WatermarkRemovalOptions,
): Promise<WatermarkRemovalResult> {
  const started = Date.now();
  const stat = await fs.stat(input).catch(() => undefined);
  if (!stat?.isFile() || stat.size < 4_096) {
    throw new VideoSystemError("FILE_VALIDATION_FAILED", `Input render is missing or too small: ${input}`);
  }
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const method = options.method ?? "auto";

  const plan: WatermarkMethod[] =
    method === "auto"
      ? ["unblend", "inpaint", "delogo"]
      : method === "ffmpeg"
        ? ["delogo"]
        : [method];

  const failures: string[] = [];
  const run = options.run ?? runProcess;
  for (const candidate of plan) {
    try {
      if (candidate === "delogo") {
        await removeWithDelogo(input, options.outputPath, options, timeoutMs, run);
        return { outputPath: options.outputPath, method: candidate, durationMs: Date.now() - started };
      }
      const scriptName = candidate === "unblend" ? "remove_watermark_v2.py" : "remove_watermark.py";
      const script = findWatermarkScript(scriptName, options.scriptPath);
      if (!script) {
        throw new VideoSystemError("POST_PROCESSING_FAILED", `${scriptName} was not found next to the server installation.`);
      }
      const result = await removeWithPython({ method: candidate, script }, input, options.outputPath, options, timeoutMs, run);
      // Both python engines print a WMV2_REPORT telemetry line on success.
      const report = parseEngineReport(result.stdoutTail);
      return {
        outputPath: options.outputPath,
        method: candidate,
        durationMs: Date.now() - started,
        registerScore: report.registerScore,
        alphaMean: report.alphaMean,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate}: ${message}`);
      logger.warn("Watermark removal attempt failed", { method: candidate, error: message });
      await fs.rm(`${options.outputPath}.part.mp4`, { force: true }).catch(() => undefined);
    }
  }
  throw new VideoSystemError("POST_PROCESSING_FAILED", `Watermark removal failed for all methods: ${failures.join(" | ")}`);
}
