import path from "path";
import fs from "fs";
import { BrowserController } from "../browser-controller.js";
import { AssetManager, type JobDirectories } from "./asset-manager.js";
import type { VideoSystemConfig } from "./config.js";
import { clickLatestDownload, revealLatestGeneratedVideoUrl, waitForBrowserDownload } from "./google-flow-provider.js";
import { VideoJobStore } from "./job-store.js";
import { inspectVideo } from "./quality-control.js";
import { removeWatermarkFromVideo } from "./watermark-remover.js";
import { sleep } from "../utils.js";

/** Flow can lag between the completion tile and a downloadable asset. */
const RETRIEVAL_DEADLINE_MS = 180_000;
/** Fast-first backoff: the encoded asset usually appears within seconds. */
const RETRIEVAL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const RETRIEVAL_STEADY_RETRY_MS = 10_000;
const DOWNLOAD_WAIT_MS = 60_000;

function retrievalRetryDelayMs(attempt: number): number {
  return RETRIEVAL_RETRY_DELAYS_MS[Math.min(attempt - 1, RETRIEVAL_RETRY_DELAYS_MS.length - 1)] ?? RETRIEVAL_STEADY_RETRY_MS;
}

/** States from which explicit operator recovery may resume retrieval. */
const RECOVERABLE_STATES = new Set(["GENERATED", "RETRIEVING", "RECOVERY_REQUIRED", "DOWNLOAD_FAILED", "GENERATION_FAILED", "QUALITY_CHECKING"]);

/** Newest usable staged clip, when retrieval already succeeded before a crash. */
async function findNewestStagedClip(sourceDirectory: string): Promise<string | undefined> {
  const entries = await fs.promises.readdir(sourceDirectory).catch(() => [] as string[]);
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!/\.(mp4|webm|mov)$/i.test(entry)) continue;
    const fullPath = path.join(sourceDirectory, entry);
    const stat = await fs.promises.stat(fullPath).catch(() => undefined);
    if (stat?.isFile() && stat.size > 4_096) candidates.push({ file: fullPath, mtime: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0]?.file;
}

/**
 * Operator recovery for a job that finished generating in Flow but failed
 * during asset retrieval. Reuses an already-staged clip when one exists
 * (no browser needed), otherwise reattaches to the still-open Flow project
 * tab with patient retries, then drives the normal pipeline tail (QC →
 * watermark removal → finalize → COMPLETED). Never submits a new generation,
 * so no additional credits are spent.
 */
export async function recoverVideoJob(
  jobId: string,
  store: VideoJobStore,
  browser: BrowserController,
  assets: AssetManager,
  config: VideoSystemConfig,
): Promise<string> {
  const job = await store.get(jobId);
  if (!job) throw new Error(`Job ${jobId} was not found.`);
  if (!RECOVERABLE_STATES.has(job.state)) {
    throw new Error(`Job ${jobId} is in state ${job.state}; recovery expects one of: ${[...RECOVERABLE_STATES].join(", ")}.`);
  }
  if (job.state === "GENERATED") {
    await store.transition(jobId, "RETRIEVING", "manual_download_recovery_started");
  } else if (job.state !== "RETRIEVING") {
    await store.transition(jobId, "RETRIEVING", "recovery_resumed_by_operator");
  }
  console.log(`[recover] Job ${jobId}: resuming asset retrieval without a new submission.`);

  const directories: JobDirectories = await assets.createJobDirectories(jobId);
  const alreadyStaged = await findNewestStagedClip(directories.source);
  if (alreadyStaged) {
    console.log(`[recover] Found already-staged clip ${path.basename(alreadyStaged)} — no browser needed.`);
  }
  const stagedPath = alreadyStaged ?? (await browser.withExclusiveJob(jobId, async (page) => {
    const currentUrl = page.url();
    console.log(`[recover] Using browser tab: ${currentUrl.slice(0, 90)}`);
    if (!currentUrl.includes("flow.google.com")) {
      throw new Error("The attached browser tab is not on flow.google.com — open the Flow project containing the clip and retry.");
    }
    await browser.configureDownloads(page, directories.temporary);

    const deadline = Date.now() + RETRIEVAL_DEADLINE_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      const directVideoUrl = await revealLatestGeneratedVideoUrl(page);
      if (directVideoUrl?.startsWith("https://")) {
        console.log(`[recover] Attempt ${attempt}: authorized asset URL found, downloading…`);
        try {
          return await assets.downloadToStaging(directVideoUrl, directories);
        } catch (error) {
          console.log(`[recover] Direct download failed (${error instanceof Error ? error.message : String(error)}); trying the batch control.`);
        }
      }
      const existing = new Set(await fs.promises.readdir(directories.temporary));
      const clickedDownload = await clickLatestDownload(page);
      if (clickedDownload) {
        console.log(`[recover] Attempt ${attempt}: clicked the newest Flow download control; waiting for the file…`);
        const downloaded = await waitForBrowserDownload(
          directories.temporary,
          existing,
          Math.min(DOWNLOAD_WAIT_MS, Math.max(5_000, deadline - Date.now())),
          async () => false,
        );
        if (downloaded) {
          const extension = path.extname(downloaded) || ".mp4";
          const target = path.join(directories.source, `flow-download-${Date.now()}${extension}`);
          await fs.promises.rename(path.join(directories.temporary, downloaded), target);
          return target;
        }
      }
      console.log(`[recover] Attempt ${attempt}: asset not ready yet; retrying in ${retrievalRetryDelayMs(attempt) / 1000} s…`);
      await sleep(retrievalRetryDelayMs(attempt));
    }
    throw new Error(`The clip never became downloadable within ${RETRIEVAL_DEADLINE_MS / 1000} s across ${attempt} attempts.`);
  }));
  console.log(`[recover] Clip staged at ${stagedPath}`);
  await store.record(jobId, "asset_retrieved", { mode: "manual_recovery" });

  await store.transition(jobId, "VALIDATING", "asset_retrieved");
  const report = await inspectVideo(stagedPath, job.request, { ffprobePath: config.ffprobePath });
  await assets.writeQualityArtifact(directories.root, "quality-report.json", report);
  await store.update(jobId, (mutable) => {
    mutable.quality = report;
  });
  if (report.verdict === "FAIL") {
    await store.transition(jobId, "INVALID_OUTPUT", "recovered_asset_failed_qc");
    throw new Error(`Recovered file failed its technical check: ${JSON.stringify(report.checks).slice(0, 300)}`);
  }
  console.log(`[recover] QC passed (${report.metadata?.width}×${report.metadata?.height}, ${report.metadata?.durationSeconds?.toFixed(1) ?? "?"} s).`);

  await store.transition(jobId, "POST_PROCESSING", "watermark_removal_started");
  const startedAt = Date.now();
  const removal = await removeWatermarkFromVideo(stagedPath, {
    outputPath: path.join(directories.processed, job.request.kind === "image" ? "clean-image.png" : "clean-video.mp4"),
    aspect: job.request.aspectRatio,
    kind: job.request.kind ?? "video",
    method: config.watermarkMethod,
    pythonPath: config.pythonPath,
    ffmpegPath: config.ffmpegPath,
    scriptPath: config.watermarkScriptPath,
  });
  const cleaned = await inspectVideo(removal.outputPath, job.request, { ffprobePath: config.ffprobePath });
  if (cleaned.verdict === "FAIL") {
    await store.transition(jobId, "POSTPROCESS_FAILED", "cleaned_asset_failed_qc");
    throw new Error("The cleaned video failed its technical re-check; the watermarked original remains archived.");
  }
  const watermarkDurationMs = Date.now() - startedAt;
  await store.record(jobId, "watermark_removed", { method: removal.method, durationMs: watermarkDurationMs });
  await store.update(jobId, (mutable) => {
    mutable.output = { rootDir: directories.root, ...mutable.output, watermark: { removed: true, method: removal.method, durationMs: watermarkDurationMs } };
  });
  console.log(`[recover] Watermark removed via ${removal.method} in ${(removal.durationMs / 1000).toFixed(1)} s.`);

  await store.transition(jobId, "QUALITY_CHECKING", "post_processing_completed");
  const finalPath = await assets.finalize(removal.outputPath, directories);
  await store.update(jobId, (mutable) => {
    mutable.output = { rootDir: directories.root, ...mutable.output, finalPath };
  });
  await store.transition(jobId, "COMPLETED", "job_completed", { finalPath });
  await assets.cleanTemporary(directories);
  console.log(`[recover] Job ${jobId} is COMPLETED — clean video at ${finalPath}`);
  return finalPath;
}
