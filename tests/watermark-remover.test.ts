import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VideoSystemError } from "../src/video/errors.js";
import { loadVideoSystemConfig } from "../src/video/config.js";
import { delogoRegionFor, findWatermarkScript, removeWatermarkFromVideo, type ProcessRunner } from "../src/video/watermark-remover.js";

test("watermark removal defaults to on and respects explicit disabling", () => {
  assert.equal(loadVideoSystemConfig({}, os.tmpdir()).watermarkRemoval, true);
  assert.equal(loadVideoSystemConfig({ FLOW_WATERMARK_REMOVAL: "false" }, os.tmpdir()).watermarkRemoval, false);
  assert.equal(loadVideoSystemConfig({ FLOW_WATERMARK_REMOVAL: "true" }, os.tmpdir()).watermarkRemoval, true);
  assert.equal(loadVideoSystemConfig({ FLOW_WATERMARK_METHOD: "ffmpeg" }, os.tmpdir()).watermarkMethod, "ffmpeg");
});

const FFPROBE_BANNER = "Input #0, mov,mp4: 'input.mp4'\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9]\n";

/** Fake ffmpeg: always reports the frame banner, copies input→output on success. */
function fakeFfmpeg(options: { failAudioCopy?: boolean } = {}): ProcessRunner {
  return async (_binary, args) => {
    if (args[0] === "-hide_banner") {
      // Frame-size probe: ffmpeg exits nonzero without an output target.
      return { code: 1, stderrTail: FFPROBE_BANNER };
    }
    if (options.failAudioCopy && !args.includes("aac")) {
      return { code: 1, stderrTail: "copy codec mismatch" };
    }
    const input = args[args.indexOf("-i") + 1];
    const output = args[args.length - 1];
    await fs.copyFile(input, output);
    return { code: 0, stderrTail: "" };
  };
}

test("delogo region targets the bottom-right badge and stays inside the frame", () => {
  for (const [width, height, aspect] of [
    [1920, 1080, "16:9"],
    [1280, 720, "16:9"],
    [720, 1280, "9:16"],
    [1080, 1920, "9:16"],
  ] as const) {
    const region = delogoRegionFor(width, height, aspect);
    assert.ok(region.x >= 2 && region.y >= 2, "box ignores the guard band");
    assert.ok(region.x + region.w <= width - 2, "box crosses the right frame edge");
    assert.ok(region.y + region.h <= height - 2, "box crosses the bottom frame edge");
    assert.ok(region.w > 20 && region.h > 20, "box implausibly small");
    assert.ok(region.x > width / 2, "badge not in the right half");
    assert.ok(region.y > height / 2, "badge not in the bottom half");
  }
});

test("square frames use the landscape geometry like the Python engine", () => {
  assert.deepEqual(delogoRegionFor(1024, 1024, "1:1"), delogoRegionFor(1024, 1024, "16:9"));
});

test("the watermark script is found relative to the repository layout", () => {
  const found = findWatermarkScript();
  assert.ok(found, "scripts/remove_watermark.py should resolve from src/ or dist/");
  assert.match(found!, /remove_watermark\.py$/);
  assert.equal(findWatermarkScript(path.join(os.tmpdir(), "definitely-missing.py")), undefined);
});

test("auto removal falls back to delogo when inpainting cannot run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-fallback-"));
  try {
    const input = path.join(root, "input.mp4");
    await fs.writeFile(input, Buffer.alloc(20_000, 7));
    const output = path.join(root, "clean", "video.mp4");
    const result = await removeWatermarkFromVideo(input, {
      outputPath: output,
      aspect: "16:9",
      method: "auto",
      // The inpaint leg fails before spawning: the script does not exist.
      scriptPath: path.join(root, "missing.py"),
      ffmpegPath: "fake-ffmpeg",
      run: fakeFfmpeg(),
      timeoutMs: 15_000,
    });
    assert.equal(result.method, "delogo");
    assert.equal((await fs.stat(output)).size, 20_000);
    assert.ok(!output.endsWith(".part.mp4"), "partial file must be renamed away");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a forced method fails instead of silently using the other engine", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-forced-"));
  try {
    const input = path.join(root, "input.mp4");
    await fs.writeFile(input, Buffer.alloc(20_000, 7));
    await assert.rejects(
      removeWatermarkFromVideo(input, {
        outputPath: path.join(root, "out.mp4"),
        aspect: "16:9",
        method: "inpaint",
        scriptPath: path.join(root, "missing.py"),
        run: fakeFfmpeg(),
        timeoutMs: 15_000,
      }),
      (error: unknown) => error instanceof VideoSystemError && error.code === "POST_PROCESSING_FAILED",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delogo retries with AAC audio when the stream copy fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-audio-"));
  try {
    const input = path.join(root, "input.mp4");
    await fs.writeFile(input, Buffer.alloc(20_000, 7));
    const output = path.join(root, "out.mp4");
    const calls: string[][] = [];
    const runner: ProcessRunner = async (binary, args) => {
      calls.push(args);
      return fakeFfmpeg({ failAudioCopy: true })(binary, args);
    };
    const result = await removeWatermarkFromVideo(input, {
      outputPath: output,
      aspect: "9:16",
      method: "delogo",
      ffmpegPath: "fake-ffmpeg",
      run: runner,
      timeoutMs: 15_000,
    });
    assert.equal(result.method, "delogo");
    assert.equal(calls.length, 3, "frame probe + audio-copy attempt + AAC retry");
    assert.ok(calls[1]?.includes("-c:a") && !calls[1]?.includes("aac"), "first pass remuxes audio");
    assert.ok(calls[2]?.includes("aac"), "second pass re-encodes audio");
    assert.equal((await fs.stat(output)).size, 20_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delogo refuses to run when no frame size can be determined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wm-probe-"));
  try {
    const input = path.join(root, "input.mp4");
    await fs.writeFile(input, Buffer.alloc(20_000, 7));
    await assert.rejects(
      removeWatermarkFromVideo(input, {
        outputPath: path.join(root, "out.mp4"),
        aspect: "16:9",
        method: "delogo",
        ffmpegPath: "fake-ffmpeg",
        run: async () => ({ code: 1, stderrTail: "no stream banner here" }),
        timeoutMs: 15_000,
      }),
      (error: unknown) => error instanceof VideoSystemError && /frame size/.test(error.message),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
