import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAllowedGoogleAssetHost, safeFileName } from "../src/video/asset-manager.js";
import { isTrustedFlowHost } from "../src/video/config.js";
import { applyCreativeDirective, interpretDirectorInstruction } from "../src/video/creative-brief.js";
import { VideoSystemError } from "../src/video/errors.js";
import { VideoJobStore } from "../src/video/job-store.js";
import { compileFlowPrompt } from "../src/video/prompt-compiler.js";
import { PriorityJobQueue } from "../src/video/priority-queue.js";
import { validateReferenceImagePaths } from "../src/video/reference-images.js";
import { assertTransition, isTerminalState } from "../src/video/state-machine.js";
import type { VideoJobState } from "../src/video/types.js";

test("director interpreter preserves locked-camera constraints through a targeted refinement", () => {
  const original = interpretDirectorInstruction(
    "A red fox walking naturally through a misty pine forest at dawn. Camera should remain locked.",
    { duration: "8s", aspectRatio: "16:9" },
  );
  const refined = applyCreativeDirective(original, "Only make the lighting warmer; keep everything else the same.");
  const prompt = compileFlowPrompt(refined);

  assert.equal(refined.camera.locked, true);
  assert.match(refined.camera.movement ?? "", /no pan/i);
  assert.match(prompt.text, /Director's required brief: Only make the lighting warmer/i);
  assert.match(prompt.text, /Avoid:.*camera movement/i);
  assert.match(prompt.constraintsApplied.join(" "), /Preserve all prior approved details/i);
});

test("failure states are terminal and cannot silently continue waiting", () => {
  for (const state of ["AUTH_REQUIRED", "UI_CHANGED", "SUBMISSION_FAILED"] as const) {
    assert.equal(isTerminalState(state), true);
  }
  assert.throws(
    () => assertTransition("SUBMITTING", "COMPLETED"),
    (error: unknown) => error instanceof VideoSystemError && error.code === "INTERNAL_ERROR",
  );
});

test("a download failure at GENERATED fails the job instead of stranding it", () => {
  // Flow finished and credits were spent; retrieval can fail before the
  // RETRIEVING transition is recorded. GENERATED must reach failure states.
  assert.doesNotThrow(() => assertTransition("GENERATED", "DOWNLOAD_FAILED"));
  assert.doesNotThrow(() => assertTransition("GENERATED", "GENERATION_FAILED"));
  assert.doesNotThrow(() => assertTransition("GENERATED", "RETRIEVING"));
  assert.equal(isTerminalState("GENERATED"), false);
});

test("operator recovery can resume retrieval from RECOVERY_REQUIRED", () => {
  assert.doesNotThrow(() => assertTransition("RECOVERY_REQUIRED", "RETRIEVING"));
});

test("operator recovery can resume retrieval after a failed job with a staged asset", () => {
  // Regression (2026-09-21): retrieval succeeded but a transition crash failed
  // the job before watermark removal, stranding three paid clips in source/.
  assert.doesNotThrow(() => assertTransition("GENERATION_FAILED", "RETRIEVING"));
  assert.doesNotThrow(() => assertTransition("DOWNLOAD_FAILED", "RETRIEVING"));
  assert.doesNotThrow(() => assertTransition("QUALITY_CHECKING", "RETRIEVING"));
  assert.throws(
    () => assertTransition("GENERATION_FAILED", "COMPLETED"),
    (error: unknown) => error instanceof VideoSystemError,
  );
});

test("the full production choreography is legal end to end", () => {
  // Regression (2026-09-21): two real jobs died mid-pipeline because runJob's
  // transitions were not all representable in this table. Walk the exact
  // sequence the orchestrator performs so this can never diverge again.
  const steps: Array<[VideoJobState, VideoJobState]> = [
    ["CREATED", "PREPARING"],
    ["PREPARING", "SUBMITTING"],
    ["SUBMITTING", "QUEUED"],
    ["QUEUED", "GENERATING"],
    ["GENERATING", "GENERATED"],
    ["GENERATED", "RETRIEVING"],
    ["RETRIEVING", "VALIDATING"],
    ["VALIDATING", "QUALITY_CHECKING"],
    ["QUALITY_CHECKING", "POST_PROCESSING"],
    ["POST_PROCESSING", "QUALITY_CHECKING"],
    ["QUALITY_CHECKING", "COMPLETED"],
  ];
  for (const [from, to] of steps) assert.doesNotThrow(() => assertTransition(from, to), `${from} → ${to}`);
});

test("asset downloads only trust Google-owned hosts", () => {
  assert.equal(isAllowedGoogleAssetHost("flow-content.google"), true);
  assert.equal(isAllowedGoogleAssetHost("cdn.flow-content.google"), true);
  assert.equal(isAllowedGoogleAssetHost("r5---sn-x.googlevideo.com"), true);
  assert.equal(isAllowedGoogleAssetHost("flow-content.google.evil.com"), false);
  assert.equal(isAllowedGoogleAssetHost("notflow-content.google"), false);
  assert.equal(isAllowedGoogleAssetHost("example.com"), false);
});

test("priority queue maintains FIFO order within priority and never duplicates a job", () => {
  const queue = new PriorityJobQueue();
  queue.enqueue("normal-first", "NORMAL");
  queue.enqueue("high", "HIGH");
  queue.enqueue("normal-second", "NORMAL");
  queue.enqueue("high", "LOW");

  assert.deepEqual(
    [queue.dequeue()?.jobId, queue.dequeue()?.jobId, queue.dequeue()?.jobId],
    ["high", "normal-first", "normal-second"],
  );
});

test("job store is durable, idempotent, and marks interrupted browser work for operator review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mcp-test-"));
  try {
    const store = new VideoJobStore(path.join(root, "state"));
    await store.initialize();
    const request = {
      instruction: "A product on a white seamless background",
      duration: "10s" as const,
      model: "gemini-omni-flash" as const,
      aspectRatio: "1:1" as const,
      idempotencyKey: "client-retry-1",
    };
    const first = await store.create(request, path.join(root, "outputs"));
    const duplicate = await store.create(request, path.join(root, "outputs"));
    assert.equal(first.id, duplicate.id);

    await store.transition(first.id, "PREPARING", "test_prepare");
    const reloaded = new VideoJobStore(path.join(root, "state"));
    await reloaded.initialize();
    const recovered = await reloaded.markInterruptedJobsForRecovery();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.state, "RECOVERY_REQUIRED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reference images require explicit absolute, recognized image files and remain attached to a job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mcp-reference-test-"));
  try {
    const imagePath = path.join(root, "product.png");
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const paths = await validateReferenceImagePaths([imagePath]);
    assert.deepEqual(paths, [await fs.realpath(imagePath)]);

    await assert.rejects(
      () => validateReferenceImagePaths(["product.png"]),
      (error: unknown) => error instanceof VideoSystemError && error.code === "PATH_VALIDATION_FAILED",
    );
    await assert.rejects(
      () => validateReferenceImagePaths([path.join(root, "not-an-image.jpg")]),
      (error: unknown) => error instanceof VideoSystemError && error.code === "PATH_VALIDATION_FAILED",
    );

    const store = new VideoJobStore(path.join(root, "state"));
    await store.initialize();
    const job = await store.create({
      instruction: "Use the supplied product reference.", duration: "8s", aspectRatio: "16:9", referenceImagePaths: paths,
    }, path.join(root, "outputs"));
    assert.deepEqual(job.request.referenceImagePaths, paths);
    assert.equal(job.request.referenceMode, "ingredients");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("asset filenames cannot escape their job directory", () => {
  assert.equal(safeFileName("../../private/.env", "video.mp4"), "env");
  assert.equal(safeFileName("???", "video.mp4"), "-");
});

test("Flow host allowlist accepts the real Flow host but rejects lookalikes", () => {
  assert.equal(isTrustedFlowHost("labs.google"), true);
  assert.equal(isTrustedFlowHost("video-fx.labs.google"), true);
  assert.equal(isTrustedFlowHost("evilgoogle.com"), false);
  assert.equal(isTrustedFlowHost("labs.google.evil.example"), false);
});
