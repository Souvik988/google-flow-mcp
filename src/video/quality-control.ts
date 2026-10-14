import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { VideoSystemError } from "./errors.js";
import type { FlowVideoDuration, QualityCheck, QualityReport, VideoMetadata } from "./types.js";

interface FfprobePayload {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    nb_frames?: string;
  }>;
}

function parseRate(value?: string): number | undefined {
  if (!value || value === "0/0") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator && denominator ? numerator / denominator : undefined;
}

function expectedAspectRatio(value: "16:9" | "9:16" | "1:1" | "3:4" | "4:3"): number {
  const [width, height] = value.split(":").map(Number);
  return width / height;
}

function check(name: string, status: QualityCheck["status"], severity: QualityCheck["severity"], details?: Record<string, unknown>): QualityCheck {
  return { name, status, severity, details };
}

async function readContainerHeader(filePath: string): Promise<{ bytes: number; isMp4: boolean }> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 4_096) {
    throw new VideoSystemError("FILE_VALIDATION_FAILED", "Downloaded video is empty or implausibly small.");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const bytesToRead = Math.min(4_096, stat.size);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return { bytes: stat.size, isMp4: buffer.includes(Buffer.from("ftyp")) };
  } finally {
    await handle.close();
  }
}

async function probeWithFfprobe(filePath: string, ffprobePath?: string): Promise<VideoMetadata | undefined> {
  if (!ffprobePath) return undefined;
  const output = await new Promise<string>((resolve, reject) => {
    const processHandle = spawn(ffprobePath, ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      processHandle.kill();
      reject(new Error("ffprobe timed out"));
    }, 15_000);
    processHandle.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    processHandle.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    processHandle.on("error", reject);
    processHandle.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
  const parsed = JSON.parse(output) as FfprobePayload;
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  return {
    bytes: (await fs.stat(filePath)).size,
    container: parsed.format?.format_name,
    durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
    width: video?.width,
    height: video?.height,
    fps: parseRate(video?.avg_frame_rate),
    frameCount: video?.nb_frames ? Number(video.nb_frames) : undefined,
    hasAudio: audio,
  };
}

export async function inspectVideo(
  filePath: string,
  expected: { duration?: FlowVideoDuration; aspectRatio: "16:9" | "9:16" | "1:1" | "3:4" | "4:3" },
  options: { ffprobePath?: string } = {},
): Promise<QualityReport> {
  const header = await readContainerHeader(filePath);
  const checks: QualityCheck[] = [
    check("file_readable", "PASS", "INFO", { bytes: header.bytes }),
    check("mp4_container_signature", header.isMp4 ? "PASS" : "FAIL", header.isMp4 ? "INFO" : "CRITICAL"),
  ];
  let metadata: VideoMetadata | undefined;
  try {
    metadata = await probeWithFfprobe(filePath, options.ffprobePath);
  } catch (error) {
    checks.push(check("ffprobe", "NOT_EVALUATED", "INFO", { reason: error instanceof Error ? error.message : "probe unavailable" }));
  }

  if (metadata?.width && metadata.height) {
    const actual = metadata.width / metadata.height;
    const expectedRatio = expectedAspectRatio(expected.aspectRatio);
    const matched = Math.abs(actual - expectedRatio) < 0.03;
    checks.push(check("aspect_ratio", matched ? "PASS" : "FAIL", matched ? "INFO" : "MAJOR", {
      expected: expected.aspectRatio,
      actual: `${metadata.width}:${metadata.height}`,
    }));
  } else {
    checks.push(check("aspect_ratio", "NOT_EVALUATED", "INFO"));
  }

  if (metadata?.durationSeconds !== undefined && expected.duration !== undefined) {
    const expectedSeconds = Number.parseInt(expected.duration, 10);
    const matched = metadata.durationSeconds >= Math.max(1, expectedSeconds * 0.45) && metadata.durationSeconds <= expectedSeconds * 2.5;
    checks.push(check("duration_sanity", matched ? "PASS" : "FAIL", matched ? "INFO" : "MAJOR", {
      expectedSeconds,
      actualSeconds: metadata.durationSeconds,
    }));
  } else {
    checks.push(check("duration_sanity", "NOT_EVALUATED", "INFO"));
  }

  checks.push(check("frame_decoding", metadata ? "PASS" : "NOT_EVALUATED", "INFO"));
  checks.push(check("semantic_review", "NOT_EVALUATED", "INFO", {
    reason: "No authorized vision evaluator is configured.",
  }));

  const critical = checks.some((item) => item.status === "FAIL" && item.severity === "CRITICAL");
  const major = checks.some((item) => item.status === "FAIL" && item.severity === "MAJOR");
  return {
    verdict: critical || major ? "FAIL" : "PASS",
    scorecard: {
      technicalIntegrity: header.isMp4 ? "PASS" : "FAIL",
      promptAdherence: "NOT_EVALUATED",
      visualCoherence: "NOT_EVALUATED",
      motionQuality: "NOT_EVALUATED",
      cameraAccuracy: "NOT_EVALUATED",
      audioIntegrity: metadata?.hasAudio === undefined ? "NOT_EVALUATED" : "PASS",
    },
    checks,
    metadata: metadata ?? { bytes: header.bytes, container: path.extname(filePath).replace(".", "") || undefined },
  };
}


const IMAGE_SIGNATURES: Array<{ name: string; test: (head: Buffer) => boolean }> = [
  { name: "png", test: (head) => head[0] === 0x89 && head.includes(Buffer.from("PNG")) },
  { name: "jpeg", test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { name: "webp", test: (head) => head.includes(Buffer.from("WEBP")) },
  { name: "gif", test: (head) => head.includes(Buffer.from("GIF8")) },
];

/** Lightweight technical check for generated still images. */
export async function inspectImage(
  filePath: string,
  options: { ffprobePath?: string } = {},
): Promise<QualityReport> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.size < 1_024) {
    throw new VideoSystemError("FILE_VALIDATION_FAILED", "Generated image is empty or implausibly small.");
  }
  const handle = await fs.open(filePath, "r");
  const head = Buffer.alloc(16);
  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const signature = IMAGE_SIGNATURES.find((candidate) => candidate.test(head));
  const checks: QualityCheck[] = [
    check("file_readable", "PASS", "INFO", { bytes: stat.size }),
    check("image_signature", signature ? "PASS" : "FAIL", signature ? "INFO" : "CRITICAL", {
      format: signature?.name ?? "unknown",
    }),
  ];
  let metadata: VideoMetadata | undefined;
  try {
    metadata = await probeWithFfprobe(filePath, options.ffprobePath);
  } catch (error) {
    checks.push(check("ffprobe", "NOT_EVALUATED", "INFO", { reason: error instanceof Error ? error.message : "probe unavailable" }));
  }
  checks.push(check("dimensions", metadata?.width && metadata?.height ? "PASS" : "NOT_EVALUATED", "INFO", {
    width: metadata?.width,
    height: metadata?.height,
  }));
  const failed = checks.some((item) => item.status === "FAIL");
  return {
    verdict: failed ? "FAIL" : "PASS",
    scorecard: {
      technicalIntegrity: failed ? "FAIL" : "PASS",
      promptAdherence: "NOT_EVALUATED",
      visualCoherence: "NOT_EVALUATED",
      motionQuality: "NOT_EVALUATED",
      cameraAccuracy: "NOT_EVALUATED",
      audioIntegrity: "NOT_EVALUATED",
    },
    checks,
    metadata: metadata ?? { bytes: stat.size },
  };
}
