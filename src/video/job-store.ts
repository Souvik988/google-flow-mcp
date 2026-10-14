import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { VideoSystemError } from "./errors.js";
import { assertTransition, isTerminalState } from "./state-machine.js";
import type { GenerationRequest, JobEvent, VideoJob, VideoJobState } from "./types.js";

interface PersistedState {
  version: 1;
  jobs: VideoJob[];
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

function createEvent(stage: VideoJobState, event: string, details?: Record<string, unknown>): JobEvent {
  return { at: now(), stage, event, details };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class VideoJobStore {
  private readonly filePath: string;
  private readonly jobs = new Map<string, VideoJob>();
  private readonly mutex = new AsyncMutex();
  private initialized = false;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "video-jobs.json");
  }

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.initialized) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const raw = await fs.readFile(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
          throw new Error("Unsupported job-store format");
        }
        for (const job of parsed.jobs) {
          // Jobs persisted before image references were introduced remain
          // usable; they simply have no references to re-upload.
          if (!Array.isArray(job.request.referenceImagePaths)) job.request.referenceImagePaths = [];
          if (!job.request.referenceImagePaths.length) job.request.referenceMode = undefined;
          this.jobs.set(job.id, job);
        }
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new VideoSystemError("CONFIGURATION_ERROR", "Could not read the persistent video job store.", {
            cause: error,
          });
        }
      }
      this.initialized = true;
    });
  }

  async create(request: GenerationRequest, outputRoot: string): Promise<VideoJob> {
    return this.mutex.run(async () => {
      this.assertInitialized();
      if (request.idempotencyKey) {
        const existing = [...this.jobs.values()].find((job) => job.idempotencyKey === request.idempotencyKey);
        if (existing) return copy(existing);
      }
      const timestamp = now();
      const job: VideoJob = {
        id: crypto.randomUUID(),
        idempotencyKey: request.idempotencyKey,
        parentJobId: request.parentJobId,
        state: "CREATED",
        priority: request.priority ?? "NORMAL",
        createdAt: timestamp,
        updatedAt: timestamp,
        request: {
          instruction: request.instruction,
          duration: request.duration,
          model: request.model ?? "gemini-omni-flash",
          aspectRatio: request.aspectRatio,
          qualityTarget: request.qualityTarget ?? "standard",
          referenceImagePaths: request.referenceImagePaths ?? [],
          referenceMode: request.referenceImagePaths?.length ? (request.referenceMode ?? "ingredients") : undefined,
          // Without kind the orchestrator runs image jobs through the video
          // agent — the bug that made generate_image render 8s clips.
          kind: request.kind,
          outputCount: request.outputCount,
        },
        creativeBrief: request.priorBrief,
        attempts: { submission: 0, generation: 0, retrieval: 0, uiRecovery: 0 },
        output: { rootDir: outputRoot },
        events: [createEvent("CREATED", "job_created")],
      };
      this.jobs.set(job.id, job);
      await this.persist();
      return copy(job);
    });
  }

  async get(jobId: string): Promise<VideoJob | undefined> {
    return this.mutex.run(async () => {
      this.assertInitialized();
      const job = this.jobs.get(jobId);
      return job ? copy(job) : undefined;
    });
  }

  async list(limit = 50): Promise<VideoJob[]> {
    return this.mutex.run(async () => {
      this.assertInitialized();
      return [...this.jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(copy);
    });
  }

  async transition(
    jobId: string,
    nextState: VideoJobState,
    event: string,
    details?: Record<string, unknown>,
  ): Promise<VideoJob> {
    return this.update(jobId, (job) => {
      assertTransition(job.state, nextState);
      job.state = nextState;
      if (!job.startedAt && nextState !== "CREATED") job.startedAt = now();
      if (isTerminalState(nextState)) job.completedAt = now();
      job.lastProgressAt = now();
      job.events.push(createEvent(nextState, event, details));
    });
  }

  async record(jobId: string, event: string, details?: Record<string, unknown>): Promise<VideoJob> {
    return this.update(jobId, (job) => {
      job.events.push(createEvent(job.state, event, details));
      job.lastProgressAt = now();
    });
  }

  async update(jobId: string, mutate: (job: VideoJob) => void): Promise<VideoJob> {
    return this.mutex.run(async () => {
      this.assertInitialized();
      const job = this.jobs.get(jobId);
      if (!job) throw new VideoSystemError("INTERNAL_ERROR", `Video job ${jobId} was not found.`);
      mutate(job);
      job.updatedAt = now();
      await this.persist();
      return copy(job);
    });
  }

  async requestCancellation(jobId: string): Promise<VideoJob> {
    return this.update(jobId, (job) => {
      job.cancellationRequested = true;
      job.events.push(createEvent(job.state, "cancellation_requested"));
    });
  }

  /**
   * Browser UI jobs lack a durable provider reference that can safely be
   * rediscovered after a restart. We deliberately refuse to submit duplicates.
   */
  async markInterruptedJobsForRecovery(): Promise<VideoJob[]> {
    return this.mutex.run(async () => {
      this.assertInitialized();
      const recoverable = new Set<VideoJobState>([
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
      ]);
      const changed: VideoJob[] = [];
      for (const job of this.jobs.values()) {
        if (!recoverable.has(job.state)) continue;
        job.state = "RECOVERY_REQUIRED";
        job.completedAt = now();
        job.updatedAt = now();
        job.error = {
          code: "RECOVERY_REQUIRED",
          message: "Server restarted during a browser-backed operation. The job was not resubmitted to avoid a duplicate generation.",
          retryable: false,
        };
        job.events.push(createEvent("RECOVERY_REQUIRED", "restart_requires_operator_review"));
        changed.push(copy(job));
      }
      if (changed.length) await this.persist();
      return changed;
    });
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload: PersistedState = { version: 1, jobs: [...this.jobs.values()] };
    await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new VideoSystemError("INTERNAL_ERROR", "Video job store has not been initialized.");
    }
  }
}
