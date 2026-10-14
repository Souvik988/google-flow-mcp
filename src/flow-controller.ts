import path from "path";
import { BridgeClient } from "./bridge-client.js";
import { downloadFile, extractDriveFileId, logger, sleep } from "./utils.js";
import { assertPathInside } from "./video/config.js";
import { VideoSystemError } from "./video/errors.js";

export interface VideoGenerationParams {
  prompt: string;
  duration: string;
  aspectRatio: string;
  negativePrompt?: string;
  seed?: number;
  style?: string;
}

export interface WorkflowTriggerResult {
  triggerId: string;
  status: string;
  message?: string;
  result?: unknown;
}

export interface FlowExecution {
  executionId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

/** Apps Script bridge adapter. Video generation now belongs to the browser job provider. */
export class FlowController {
  private client?: BridgeClient;

  private get bridge(): BridgeClient {
    if (!this.client) this.client = new BridgeClient();
    return this.client;
  }

  async triggerWorkflow(name: string, inputs: Record<string, unknown>, waitForCompletion: boolean): Promise<WorkflowTriggerResult> {
    logger.info("Triggering bridge workflow", { workflowName: name, waitForCompletion });
    return this.bridge.post<WorkflowTriggerResult>("triggerWorkflow", { workflowName: name, inputs, waitForCompletion });
  }

  async listWorkflows(): Promise<unknown[]> {
    return this.bridge.get<unknown[]>("listWorkflows");
  }

  async getExecutionStatus(executionId: string): Promise<FlowExecution> {
    return this.bridge.get<FlowExecution>("getStatus", { executionId });
  }

  async createWorkflow(name: string, description: string, steps: unknown[]): Promise<unknown> {
    return this.bridge.post("createWorkflow", { workflowName: name, description, steps });
  }

  async deleteWorkflow(workflowId: string): Promise<unknown> {
    return this.bridge.post("deleteWorkflow", { workflowId });
  }

  /**
   * Kept for source compatibility only. The legacy Apps Script queue never
   * submitted a Flow/Veo generation, so callers are directed to the durable MCP
   * job API instead of receiving a misleading queued response.
   */
  async generateVideo(_params: VideoGenerationParams): Promise<never> {
    throw new VideoSystemError(
      "SUBMISSION_FAILED",
      "The Apps Script bridge cannot submit Google Flow videos. Use generate_video, which now uses the authenticated browser provider and a persistent job record.",
    );
  }

  async getVideoStatus(requestId: string): Promise<unknown> {
    return this.bridge.get("getVideoStatus", { requestId });
  }

  async generateVideoAndWait(_params: VideoGenerationParams & { outputPath?: string; maxWaitSeconds?: number; pollIntervalMs?: number }): Promise<never> {
    return this.generateVideo(_params);
  }

  async listGeneratedVideos(folderId?: string): Promise<unknown[]> {
    const result = await this.bridge.post<{ files?: unknown[] }>("driveList", { folderId, fileType: "video/" });
    return result.files ?? [];
  }

  async downloadVideo(url: string, outputPath: string, filename?: string): Promise<string> {
    const workspaceRoot = process.cwd();
    const outputRoot = assertPathInside(workspaceRoot, path.resolve(workspaceRoot, process.env.FLOW_OUTPUT_DIR ?? "outputs"));
    const directory = assertPathInside(outputRoot, path.resolve(workspaceRoot, outputPath));
    const safeName = path.basename(filename || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "-") || "video.mp4";
    const destination = assertPathInside(outputRoot, path.join(directory, safeName));
    const fileId = extractDriveFileId(url);
    if (/^[-\w]{25,50}$/.test(fileId)) {
      const info = await this.bridge.post<{ downloadUrl?: string; name?: string }>("driveGetDownloadUrl", { fileId });
      if (!info.downloadUrl) throw new VideoSystemError("DOWNLOAD_FAILED", "Bridge did not return a Drive download URL.");
      const derivedDestination = filename ? destination : assertPathInside(outputRoot, path.join(directory, path.basename(info.name || safeName)));
      return downloadFile(info.downloadUrl, derivedDestination, { allowedHosts: ["google.com", "googleusercontent.com", "googlevideo.com"] });
    }
    return downloadFile(url, destination, { allowedHosts: ["google.com", "googleusercontent.com", "googlevideo.com"] });
  }

  async healthCheck(): Promise<unknown> {
    return this.bridge.get("health");
  }

  /** Legacy polling helper for existing external bridge status IDs only. */
  async waitForLegacyVideoStatus(requestId: string, timeoutMs = 180_000): Promise<unknown> {
    const started = Date.now();
    let interval = 2_000;
    while (Date.now() - started < timeoutMs) {
      const result = await this.getVideoStatus(requestId) as { status?: string };
      if (["completed", "failed", "not_found"].includes(result.status ?? "")) return result;
      await sleep(interval);
      interval = Math.min(15_000, Math.round(interval * 1.5));
    }
    throw new VideoSystemError("GENERATION_TIMEOUT", "Legacy bridge video status did not reach a terminal state.");
  }
}
