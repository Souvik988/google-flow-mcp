import path from "path";
import { BrowserController } from "../browser-controller.js";
import { logger, sleep } from "../utils.js";
import { AssetManager, type JobDirectories } from "./asset-manager.js";
import { applyCreativeDirective, interpretDirectorInstruction } from "./creative-brief.js";
import type { VideoSystemConfig } from "./config.js";
import { asVideoSystemError, VideoSystemError, type VideoErrorCode } from "./errors.js";
import { GoogleFlowBrowserProvider } from "./google-flow-provider.js";
import { VideoJobStore } from "./job-store.js";
import { compileFlowPrompt, buildRefinementDirective } from "./prompt-compiler.js";
import { PriorityJobQueue } from "./priority-queue.js";
import { inspectImage, inspectVideo } from "./quality-control.js";
import { validateReferenceImagePaths } from "./reference-images.js";
import { isTerminalState } from "./state-machine.js";
import type { CreativeBrief, GenerationRequest, VideoJob, VideoJobState, WatermarkOutcome } from "./types.js";
import { removeWatermarkFromVideo } from "./watermark-remover.js";
import { recoverVideoJob } from "./job-recovery.js";

export class VideoOrchestrator {
  private readonly store: VideoJobStore;
  private readonly queue = new PriorityJobQueue();
  private readonly assets: AssetManager;
  private readonly provider: GoogleFlowBrowserProvider;
  private initialized = false;
  private accepting = true;
  private workerActive = false;
  private activeJobId?: string;

  constructor(
    private readonly browser: BrowserController,
    private readonly config: VideoSystemConfig,
  ) {
    this.store = new VideoJobStore(config.stateDir);
    this.assets = new AssetManager(config.outputDir);
    this.provider = new GoogleFlowBrowserProvider(browser, this.assets, config);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    const recovered = await this.store.markInterruptedJobsForRecovery();
    if (recovered.length) {
      logger.warn("In-flight browser jobs require operator review after restart", { count: recovered.length });
    }
    this.initialized = true;
    const queuedBeforeRestart = (await this.store.list(10_000)).filter((job) => job.state === "CREATED" && !job.cancellationRequested);
    for (const job of queuedBeforeRestart) this.queue.enqueue(job.id, job.priority);
    if (queuedBeforeRestart.length) this.startWorker();
  }

  async submit(request: GenerationRequest): Promise<VideoJob> {
    await this.initialize();
    if (!this.accepting) {
      throw new VideoSystemError("CANCELLED", "Video server is shutting down and is not accepting new jobs.");
    }
    const referenceImagePaths = await validateReferenceImagePaths(request.referenceImagePaths);
    const job = await this.store.create({
      ...request,
      referenceImagePaths,
      referenceMode: referenceImagePaths.length ? "ingredients" : undefined,
    }, this.config.outputDir);
    if (job.state === "CREATED") {
      this.queue.enqueue(job.id, job.priority);
      this.startWorker();
    }
    return job;
  }

  async get(jobId: string): Promise<VideoJob | undefined> {
    await this.initialize();
    return this.store.get(jobId);
  }

  async list(limit?: number): Promise<VideoJob[]> {
    await this.initialize();
    return this.store.list(limit);
  }

  async cancel(jobId: string): Promise<VideoJob> {
    await this.initialize();
    const job = await this.store.get(jobId);
    if (!job) throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} was not found.`);
    if (isTerminalState(job.state)) return job;
    this.queue.remove(jobId);
    const requested = await this.store.requestCancellation(jobId);
    if (requested.state === "CREATED") {
      return this.store.transition(jobId, "CANCELLED", "cancelled_while_queued");
    }
    return requested;
  }

  async refine(jobId: string, directive: string, priority?: GenerationRequest["priority"]): Promise<VideoJob> {
    await this.initialize();
    const original = await this.store.get(jobId);
    if (!original?.creativeBrief) {
      throw new VideoSystemError("INTERNAL_ERROR", "The requested job has no creative brief to refine.");
    }
    const brief = applyCreativeDirective(original.creativeBrief, directive);
    return this.submit({
      instruction: directive,
      duration: original.request.duration,
      model: original.request.model ?? this.config.defaultVideoModel,
      aspectRatio: original.request.aspectRatio,
      priority: priority ?? original.priority,
      qualityTarget: original.request.qualityTarget,
      referenceImagePaths: original.request.referenceImagePaths,
      referenceMode: original.request.referenceMode,
      parentJobId: original.id,
      priorBrief: brief,
    });
  }

  async regenerate(jobId: string, priority?: GenerationRequest["priority"]): Promise<VideoJob> {
    return this.refine(jobId, "Regenerate the approved creative brief as a new version.", priority);
  }

  async waitForTerminal(jobId: string, timeoutMs: number): Promise<VideoJob> {
    const startedAt = Date.now();
    let interval = 250;
    while (Date.now() - startedAt < timeoutMs) {
      const job = await this.get(jobId);
      if (!job) throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} was not found.`);
      if (isTerminalState(job.state)) return job;
      await sleep(interval);
      interval = Math.min(1_500, Math.round(interval * 1.4));
    }
    const job = await this.get(jobId);
    if (!job) throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} was not found.`);
    return job;
  }

  async health(): Promise<Record<string, unknown>> {
    await this.initialize();
    const jobs = await this.store.list(500);
    return {
      status: "ok",
      acceptingJobs: this.accepting,
      activeJobId: this.activeJobId,
      queuedJobs: this.queue.size,
      browserConnected: this.browser.connected,
      totals: jobs.reduce<Record<string, number>>((totals, job) => {
        totals[job.state] = (totals[job.state] ?? 0) + 1;
        return totals;
      }, {}),
      concurrency: {
        configured: this.config.maxConcurrency,
        effective: 1,
        reason: "One active Flow job per persistent browser profile prevents UI-state corruption.",
      },
    };
  }

  /**
   * Operator-facing self-healing: resumes asset retrieval for a job whose
   * Flow generation finished but whose download failed or was interrupted.
   * Never submits a new generation, so no additional credits are spent.
   */
  async recoverRetrieval(jobId: string): Promise<VideoJob> {
    await this.initialize();
    const existing = await this.store.get(jobId);
    if (!existing) throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} was not found.`);
    const recoverable = new Set(["GENERATED", "RETRIEVING", "RECOVERY_REQUIRED", "DOWNLOAD_FAILED", "GENERATION_FAILED", "QUALITY_CHECKING"]);
    if (!recoverable.has(existing.state)) {
      throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} is in state ${existing.state}; nothing to recover.`);
    }
    await recoverVideoJob(jobId, this.store, this.browser, this.assets, this.config);
    const recovered = await this.store.get(jobId);
    return recovered ?? existing;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    if (this.activeJobId) {
      await this.store.requestCancellation(this.activeJobId);
      await this.store.record(this.activeJobId, "shutdown_requested");
    }
  }

  private startWorker(): void {
    if (this.workerActive) return;
    this.workerActive = true;
    void this.runWorker().finally(() => {
      this.workerActive = false;
      if (this.queue.size && this.accepting) this.startWorker();
    });
  }

  private async runWorker(): Promise<void> {
    while (this.accepting) {
      const queued = this.queue.dequeue();
      if (!queued) return;
      const job = await this.store.get(queued.jobId);
      if (!job || (job.state !== "CREATED" && job.state !== "PREPARING")) continue;
      this.activeJobId = job.id;
      try {
        await this.runJob(job.id);
      } catch (error) {
        logger.error("Unexpected worker error", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.activeJobId = undefined;
      }
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const existing = await this.store.get(jobId);
    if (!existing) return;
    let job = existing.state === "CREATED"
      ? await this.store.transition(jobId, "PREPARING", "job_preparation_started")
      : existing;
    try {
      const directories = await this.assets.createJobDirectories(job.id);
      job = await this.store.update(job.id, (mutable) => {
        mutable.output = { ...mutable.output, rootDir: directories.root };
      });
      const isImage = job.request.kind === "image";
      // Image renders skip the director-brief machinery: the caller's prompt
      // is the creative instruction and is passed to Flow verbatim.
      const brief = isImage
        ? undefined
        : job.creativeBrief ?? interpretDirectorInstruction(job.request.instruction, {
          duration: job.request.duration ?? "8s",
          aspectRatio: job.request.aspectRatio,
        });
      const compiled = brief
        ? compileFlowPrompt(brief)
        : { text: job.request.instruction, constraintsApplied: [] as string[] };
      await this.store.update(job.id, (mutable) => {
        mutable.creativeBrief = brief;
        mutable.compiledPrompt = compiled;
      });
      if (brief) {
        await this.assets.writeRequestArtifact(directories.root, "creative-brief.json", brief);
      }
      await this.assets.writeTextArtifact(directories.root, "prompt.txt", compiled.text);
      if (job.request.referenceImagePaths.length) {
        await this.assets.writeRequestArtifact(directories.root, "reference-images.json", {
          mode: job.request.referenceMode,
          paths: job.request.referenceImagePaths,
        });
      }
      await this.store.record(job.id, "prompt_compiled", { constraints: compiled.constraintsApplied.length });

      if ((await this.store.get(job.id))?.cancellationRequested) {
        await this.store.transition(job.id, "CANCELLED", "cancelled_before_submission");
        await this.assets.cleanTemporary(directories);
        return;
      }

      job = await this.store.transition(job.id, "SUBMITTING", "provider_submission_started");
      await this.store.update(job.id, (mutable) => {
        mutable.attempts.submission += 1;
        mutable.attempts.generation += 1;
        mutable.provider = "google-flow-browser";
      });
      const outcome = await this.provider.generate(
        job.id,
        {
          prompt: compiled.text,
          duration: job.request.duration,
          model: job.request.model,
          aspectRatio: job.request.aspectRatio,
          referenceImagePaths: job.request.referenceImagePaths,
          referenceMode: job.request.referenceMode,
          kind: job.request.kind ?? "video",
          outputCount: job.request.outputCount,
          maxWaitMs: this.config.generationTimeoutMs,
          isCancelled: async () => Boolean((await this.store.get(job.id))?.cancellationRequested),
          onProgress: (event, details) => this.handleProviderProgress(job.id, event, details),
        },
        directories,
      );
      await this.store.update(job.id, (mutable) => {
        mutable.providerReference = outcome.reference;
        mutable.output = { rootDir: mutable.output?.rootDir ?? directories.root, ...mutable.output, sourceUrl: outcome.sourceUrl };
      });

      // Retrieval can complete without any intermediate download event having
      // been recorded (direct fetch on the first poll). Never trust event
      // ordering for the state machine: normalize to RETRIEVING here so the
      // GENERATED → VALIDATING transition is always legal.
      const postRetrieval = await this.store.get(job.id);
      if (postRetrieval?.state === "GENERATED") {
        await this.store.transition(job.id, "RETRIEVING", "asset_retrieval_completed");
      }
      await this.transitionIfNeeded(job.id, "VALIDATING", "asset_retrieved");
      const report = isImage
        ? await inspectImage(outcome.stagedPath, { ffprobePath: this.config.ffprobePath })
        : await inspectVideo(outcome.stagedPath, job.request, { ffprobePath: this.config.ffprobePath });
      await this.assets.writeQualityArtifact(directories.root, "quality-report.json", report);
      await this.store.update(job.id, (mutable) => {
        mutable.quality = report;
      });
      await this.transitionIfNeeded(job.id, "QUALITY_CHECKING", "technical_quality_check_completed", { verdict: report.verdict });

      if (report.verdict === "FAIL") {
        // Images have no prompt-repair loop: a failed render is a hard reject.
        if (isImage) {
          await this.store.transition(job.id, "INVALID_OUTPUT", "image_failed_qc");
          await this.assets.cleanTemporary(directories);
          return;
        }
        await this.handleQualityFailure(job.id, brief!, report.verdict);
        await this.assets.cleanTemporary(directories);
        return;
      }

      // Post-processing: strip the Veo sparkle watermark so the delivered file
      // is clean. Best-effort by design — a failed removal never wastes a paid
      // generation; the job records the outcome and delivers the original.
      await this.transitionIfNeeded(job.id, "POST_PROCESSING", "watermark_removal_started");
      const watermark = await this.removeWatermarkStage(job.id, outcome.stagedPath, directories);
      const deliverablePath = watermark.outputPath ?? outcome.stagedPath;
      await this.transitionIfNeeded(job.id, "QUALITY_CHECKING", "post_processing_completed", { removed: watermark.removed, method: watermark.method });

      const finalPath = await this.assets.finalize(deliverablePath, directories, isImage ? "image.png" : "video.mp4");
      await this.store.update(job.id, (mutable) => {
        mutable.output = { rootDir: mutable.output?.rootDir ?? directories.root, ...mutable.output, finalPath };
      });
      await this.store.transition(job.id, "COMPLETED", "job_completed", { finalPath });
      await this.assets.cleanTemporary(directories);
    } catch (error) {
      await this.handleFailure(jobId, asVideoSystemError(error));
    }
  }

  /**
   * Removes the Veo sparkle watermark from the staged clip and records the
   * outcome on the job. Never throws: when removal is disabled or fails the
   * caller keeps the original watermarked file and the job still completes.
   */
  private async removeWatermarkStage(
    jobId: string,
    stagedPath: string,
    directories: JobDirectories,
  ): Promise<WatermarkOutcome & { outputPath?: string }> {
    const job = await this.store.get(jobId);
    if (!job) return { removed: false };
    const persist = async (outcome: WatermarkOutcome): Promise<void> => {
      await this.store.update(jobId, (mutable) => {
        mutable.output = { rootDir: mutable.output?.rootDir ?? directories.root, ...mutable.output, watermark: outcome };
      });
    };
    if (!this.config.watermarkRemoval) {
      const outcome: WatermarkOutcome = { removed: false, skipped: true };
      await this.store.record(jobId, "watermark_removal_skipped", { reason: "disabled" });
      await persist(outcome);
      return outcome;
    }
    const startedAt = Date.now();
    try {
      const result = await removeWatermarkFromVideo(stagedPath, {
        outputPath: path.join(directories.processed, job.request.kind === "image" ? "clean-image.png" : "clean-video.mp4"),
        aspect: job.request.aspectRatio,
        kind: job.request.kind ?? "video",
        method: this.config.watermarkMethod,
        pythonPath: this.config.pythonPath,
        ffmpegPath: this.config.ffmpegPath,
        scriptPath: this.config.watermarkScriptPath,
      });
      // The cleaned clip was re-encoded, so re-run the technical checks before
      // letting it replace the validated original as the deliverable.
      const cleaned = await inspectVideo(result.outputPath, job.request, { ffprobePath: this.config.ffprobePath });
      if (cleaned.verdict === "FAIL") {
        throw new VideoSystemError("POST_PROCESSING_FAILED", "The cleaned video failed its technical re-check.");
      }
      const outcome: WatermarkOutcome = { removed: true, method: result.method, durationMs: Date.now() - startedAt };
      await this.store.record(jobId, "watermark_removed", { method: result.method, durationMs: outcome.durationMs });
      await persist(outcome);
      return { ...outcome, outputPath: result.outputPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Watermark removal did not run; delivering the original clip", { jobId, error: message });
      const outcome: WatermarkOutcome = { removed: false, error: message };
      await this.store.record(jobId, "watermark_removal_failed", { message });
      await persist(outcome);
      return outcome;
    }
  }

  private async handleProviderProgress(
    jobId: string,
    event: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const job = await this.store.get(jobId);
    if (!job || isTerminalState(job.state)) return;
    if (event === "generation_submitted" && job.state === "SUBMITTING") {
      await this.store.transition(jobId, "QUEUED", event, details);
      return;
    }
    if (event === "generation_progress" && job.state === "QUEUED") {
      await this.store.transition(jobId, "GENERATING", event, details);
      return;
    }
    // Any retrieval activity (batch download, direct fetch, retries) means the
    // job is past generation: entering RETRIEVING keeps the state machine
    // coherent no matter which retrieval path succeeds first.
    if (event.startsWith("download_") && (job.state === "QUEUED" || job.state === "GENERATING" || job.state === "GENERATED")) {
      await this.store.transition(jobId, "RETRIEVING", event, details);
      return;
    }
    if (event === "generation_completed" && (job.state === "QUEUED" || job.state === "GENERATING")) {
      await this.store.transition(jobId, "GENERATED", event, details);
      return;
    }
    await this.store.record(jobId, event, details);
  }

  private async handleQualityFailure(jobId: string, brief: CreativeBrief, reason: string): Promise<void> {
    const job = await this.store.get(jobId);
    if (!job) return;
    if (job.attempts.generation < this.config.maxGenerationAttempts && !job.cancellationRequested) {
      const refinedBrief = applyCreativeDirective(brief, buildRefinementDirective(brief, reason));
      await this.store.update(jobId, (mutable) => {
        mutable.creativeBrief = refinedBrief;
        mutable.compiledPrompt = compileFlowPrompt(refinedBrief);
      });
      await this.store.transition(jobId, "PREPARING", "quality_refinement_planned", { attempt: job.attempts.generation + 1 });
      this.queue.enqueue(jobId, job.priority);
      this.startWorker();
      return;
    }
    await this.store.transition(jobId, "QUALITY_REJECTED", "quality_rejected", { reason });
  }

  private async handleFailure(jobId: string, error: VideoSystemError): Promise<void> {
    const job = await this.store.get(jobId);
    if (!job || isTerminalState(job.state)) return;
    const target = failureStateFor(job.state, error.code);
    try {
      await this.store.update(jobId, (mutable) => {
        mutable.error = { code: error.code, message: error.message, retryable: error.retryable };
      });
      await this.store.transition(jobId, target, "job_failed", { code: error.code });
    } catch (transitionError) {
      logger.error("Could not persist job failure transition", {
        jobId,
        error: transitionError instanceof Error ? transitionError.message : String(transitionError),
      });
    }
  }

  private async transitionIfNeeded(
    jobId: string,
    desired: VideoJobState,
    event: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const job = await this.store.get(jobId);
    if (!job || job.state === desired) return;
    await this.store.transition(jobId, desired, event, details);
  }
}

function failureStateFor(current: VideoJobState, code: VideoErrorCode): VideoJobState {
  if (code === "CANCELLED") return "CANCELLED";
  if (code === "AUTH_REQUIRED" && (current === "PREPARING" || current === "SUBMITTING")) return "AUTH_REQUIRED";
  if ((code === "FLOW_UI_CHANGED" || code === "SELECTOR_RESOLUTION_FAILED") && current === "SUBMITTING") return "UI_CHANGED";
  if ((code === "SUBMISSION_FAILED" || code === "BROWSER_DISCONNECTED") && current === "SUBMITTING") return "SUBMISSION_FAILED";
  if (code === "GENERATION_TIMEOUT" && ["QUEUED", "GENERATING", "PROCESSING"].includes(current)) return "TIMEOUT";
  if (code === "DOWNLOAD_FAILED" && ["GENERATED", "RETRIEVING"].includes(current)) return "DOWNLOAD_FAILED";
  if (code === "FILE_VALIDATION_FAILED" && current === "VALIDATING") return "INVALID_OUTPUT";
  if (code === "QUALITY_CONTROL_FAILED" && current === "QUALITY_CHECKING") return "QUALITY_REJECTED";
  if (code === "POST_PROCESSING_FAILED" && current === "POST_PROCESSING") return "POSTPROCESS_FAILED";
  if (["QUEUED", "GENERATING", "PROCESSING", "GENERATED", "RETRIEVING", "VALIDATING", "QUALITY_CHECKING"].includes(current)) {
    return "GENERATION_FAILED";
  }
  return "SUBMISSION_FAILED";
}
