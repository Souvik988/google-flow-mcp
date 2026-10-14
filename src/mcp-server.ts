import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import { z } from "zod";
import { FlowController } from "./flow-controller.js";
import { GoogleAPIs } from "./google-apis.js";
import { BrowserController } from "./browser-controller.js";
import type { VideoSystemConfig } from "./video/config.js";
import { asVideoSystemError } from "./video/errors.js";
import { VideoOrchestrator } from "./video/orchestrator.js";
import { removeWatermarkFromVideo } from "./video/watermark-remover.js";
import { FLOW_VIDEO_DURATIONS, FLOW_VIDEO_MODELS, type FlowVideoDuration, type FlowVideoModel, type GenerationRequest, type VideoJob } from "./video/types.js";

export interface FlowMcpDependencies {
  config: VideoSystemConfig;
  browser: BrowserController;
  videos: VideoOrchestrator;
  flows: FlowController;
  apis: GoogleAPIs;
}

/**
 * Builds a fully-registered MCP server instance. Each transport (stdio and the
 * streamable-HTTP /mcp endpoint) needs its own instance, but they share the
 * controllers passed in through dependencies.
 */
export function createFlowMcpServer(dependencies: FlowMcpDependencies): McpServer {
  const server = new McpServer({
    name: "google-flow-mcp",
    version: "1.0.0",
  });
  const { config: videoConfig, flows: flowController, apis: googleAPIs, browser: browserController, videos: videoOrchestrator } = dependencies;

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const normalized = asVideoSystemError(error);
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable } }, null, 2),
    }],
  };
}

function publicVideoJob(job: VideoJob) {
  return {
    jobId: job.id,
    parentJobId: job.parentJobId,
    status: job.state,
    priority: job.priority,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    lastProgressAt: job.lastProgressAt,
    attempts: job.attempts,
    output: job.output,
    delivery: job.output?.finalPath
      ? {
          // Absolute coordinates so agents can open the clip directly in the IDE.
          localPath: job.output.finalPath,
          fileName: path.basename(job.output.finalPath),
          directory: job.output.rootDir,
          watermarkRemoved: job.output.watermark?.removed === true,
        }
      : undefined,
    quality: job.quality,
    error: job.error,
    events: job.events,
    referenceImages: job.request.referenceImagePaths?.length
      ? { mode: job.request.referenceMode ?? "ingredients", count: job.request.referenceImagePaths.length }
      : undefined,
    creativeBrief: job.creativeBrief,
    compiledPrompt: job.compiledPrompt,
  };
}

const FLOW_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "3:4", "4:3"] as const;

function buildGenerationRequest(input: {
  prompt: string;
  duration: FlowVideoDuration;
  model?: FlowVideoModel;
  aspectRatio: (typeof FLOW_ASPECT_RATIOS)[number];
  negativePrompt?: string;
  style?: string;
  priority?: "LOW" | "NORMAL" | "HIGH";
  idempotencyKey?: string;
  qualityTarget?: "standard" | "high";
  referenceImagePaths?: string[];
}): GenerationRequest {
  const additions = [
    input.prompt,
    input.negativePrompt ? `Avoid: ${input.negativePrompt}` : "",
    input.style ? `Visual style: ${input.style}` : "",
  ].filter(Boolean);
  return {
    instruction: additions.join("\n"),
    duration: input.duration,
    model: input.model ?? videoConfig.defaultVideoModel,
    aspectRatio: input.aspectRatio,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
    qualityTarget: input.qualityTarget,
    referenceImagePaths: input.referenceImagePaths,
    referenceMode: input.referenceImagePaths?.length ? "ingredients" : undefined,
  };
}

function buildImageGenerationRequest(input: {
  prompt: string;
  aspectRatio: (typeof FLOW_ASPECT_RATIOS)[number];
  outputCount?: number;
  style?: string;
  referenceImagePaths?: string[];
  idempotencyKey?: string;
  priority?: "LOW" | "NORMAL" | "HIGH";
}): GenerationRequest {
  const instruction = [input.prompt, input.style ? `Visual style: ${input.style}` : ""].filter(Boolean).join("\n");
  return {
    instruction,
    aspectRatio: input.aspectRatio,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
    qualityTarget: "standard",
    referenceImagePaths: input.referenceImagePaths,
    referenceMode: input.referenceImagePaths?.length ? "ingredients" : undefined,
    kind: "image",
    outputCount: input.outputCount,
  };
}

// ╔══════════════════════════════════════════╗
// ║   FLOW WORKFLOW TOOLS (6 tools)         ║
// ╚══════════════════════════════════════════╝

server.tool(
  "trigger_flow",
  "Trigger a legacy bridge workflow record by name with optional input parameters. This is not a Google Flow/Veo generation.",
  {
    workflowName: z.string().describe("Name of the Flow workflow to trigger"),
    inputs: z.record(z.any()).default({}).describe("Input parameters for the workflow"),
    waitForCompletion: z.boolean().default(false).describe("Whether to wait for workflow completion before returning"),
  },
  async ({ workflowName, inputs, waitForCompletion }) => {
    try {
      const result = await flowController.triggerWorkflow(workflowName, inputs, waitForCompletion);
      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ Flow "${workflowName}" triggered successfully.`,
            `Trigger ID: ${result.triggerId}`,
            `Status: ${result.status}`,
            result.message ? `Message: ${result.message}` : "",
            result.result ? `\nResult:\n${JSON.stringify(result.result, null, 2)}` : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "list_flows",
  "List legacy bridge workflow records. These are not Google Flow/Veo projects.",
  {},
  async () => {
    try {
      const flows = await flowController.listWorkflows();
      return {
        content: [{
          type: "text" as const,
          text: flows.length > 0
            ? `📋 Available Flows (${flows.length}):\n${JSON.stringify(flows, null, 2)}`
            : "No flows found.",
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "get_flow_status",
  "Get the status of a legacy bridge workflow record.",
  {
    executionId: z.string().describe("The execution/trigger ID from a previous trigger_flow call"),
  },
  async ({ executionId }) => {
    try {
      const status = await flowController.getExecutionStatus(executionId);
      return {
        content: [{
          type: "text" as const,
          text: `📊 Execution Status:\n${JSON.stringify(status, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "create_flow",
  "Create a legacy bridge workflow record with defined steps; this does not create a Google Flow UI workflow.",
  {
    name: z.string().describe("Name for the new workflow"),
    description: z.string().default("").describe("Description of the workflow"),
    steps: z.array(z.record(z.any())).default([]).describe("Array of workflow step definitions"),
  },
  async ({ name, description, steps }) => {
    try {
      const result = await flowController.createWorkflow(name, description, steps);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Workflow "${name}" created.\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "delete_flow",
  "Mark a legacy bridge workflow record deleted by ID.",
  {
    workflowId: z.string().describe("The workflow ID to delete"),
  },
  async ({ workflowId }) => {
    try {
      const result = await flowController.deleteWorkflow(workflowId);
      return {
        content: [{
          type: "text" as const,
          text: `🗑️ Workflow deleted.\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   VIDEO GENERATION (VEO) TOOLS (4)      ║
// ╚══════════════════════════════════════════╝

server.tool(
  "generate_video",
  "Create a durable Google Flow video job. The instruction is interpreted as a director brief, compiled into a Flow prompt, and processed asynchronously by default.",
  {
    prompt: z.string().min(3).max(8_000).describe("Director-style video instruction"),
    duration: z.enum(FLOW_VIDEO_DURATIONS).default("8s").describe("Clip length. Gemini Omni Flash supports 4, 6, 8, and 10 seconds in Flow."),
    model: z.enum(FLOW_VIDEO_MODELS).default("gemini-omni-flash").describe("Flow generation model. Use gemini-omni-flash for a 10-second standard clip."),
    aspectRatio: z.enum(FLOW_ASPECT_RATIOS).default("16:9").describe("Frame aspect ratio — Flow offers 16:9, 4:3, 1:1, 3:4, 9:16"),
    negativePrompt: z.string().max(2_000).optional().describe("Explicit visual constraints to avoid"),
    style: z.string().max(500).optional().describe("Optional visual style direction"),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL").describe("Queue priority; never interrupts an active job"),
    idempotencyKey: z.string().min(1).max(128).optional().describe("Prevents duplicate generations when an MCP client retries"),
    qualityTarget: z.enum(["standard", "high"]).default("standard").describe("High enables future semantic-QC integrations when configured"),
    referenceImagePaths: z.array(z.string().min(1).max(4_096)).min(1).max(5).optional().describe("Optional absolute local PNG, JPEG, or WebP file paths. Each is uploaded through Google Flow's Ingredients drawer as a visual reference; files are never inferred or scanned."),
    waitForCompletion: z.boolean().default(false).describe("Wait only up to the configured bounded generation deadline; false returns the job immediately"),
    outputPath: z.string().optional().describe("Deprecated and ignored: outputs are safely organized under outputs/<job-id>/"),
  },
  async ({ prompt, duration, model, aspectRatio, negativePrompt, style, priority, idempotencyKey, qualityTarget, referenceImagePaths, waitForCompletion }) => {
    try {
      const job = await videoOrchestrator.submit(buildGenerationRequest({
        prompt, duration, model, aspectRatio, negativePrompt, style, priority, idempotencyKey, qualityTarget, referenceImagePaths,
      }));
      const result = waitForCompletion
        ? await videoOrchestrator.waitForTerminal(job.id, videoConfig.generationTimeoutMs + 30_000)
        : job;
      return jsonResult({
        ...publicVideoJob(result),
        next: result.state === "COMPLETED" ? undefined : { tool: "get_video_job", jobId: result.id },
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "generate_image",
  "Create a durable Google Flow IMAGE job: still renders in any Flow aspect ratio (16:9, 4:3, 1:1, 3:4, 9:16) with 1-4 variations, then watermark removal and local delivery. The prompt is passed to Flow verbatim as the visual instruction.",
  {
    prompt: z.string().min(3).max(8_000).describe("Visual instruction for the still image, described like an art director (subject, composition, lighting, style)"),
    aspectRatio: z.enum(FLOW_ASPECT_RATIOS).default("1:1").describe("Image frame ratio. Use 3:4 or 4:3 for icon/print shapes, 1:1 for avatars/icons, 16:9/9:16 for scenes"),
    outputCount: z.number().int().min(1).max(4).default(1).describe("How many variations Flow renders (x1-x4)"),
    style: z.string().max(500).optional().describe("Optional visual style direction"),
    referenceImagePaths: z.array(z.string().min(1).max(4_096)).min(1).max(5).optional().describe("Optional absolute local PNG/JPEG/WebP paths attached as Flow Ingredients (visual references)"),
    idempotencyKey: z.string().min(1).max(128).optional().describe("Prevents duplicate generations when an MCP client retries"),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL").describe("Queue priority"),
    waitForCompletion: z.boolean().default(false).describe("Wait only up to the configured bounded deadline; false returns the job immediately"),
  },
  async ({ prompt, aspectRatio, outputCount, style, referenceImagePaths, idempotencyKey, priority, waitForCompletion }) => {
    try {
      const job = await videoOrchestrator.submit(buildImageGenerationRequest({
        prompt, aspectRatio, outputCount, style, referenceImagePaths, idempotencyKey, priority,
      }));
      const result = waitForCompletion
        ? await videoOrchestrator.waitForTerminal(job.id, videoConfig.generationTimeoutMs + 30_000)
        : job;
      return jsonResult({
        ...publicVideoJob(result),
        next: result.state === "COMPLETED" ? undefined : { tool: "get_video_job", jobId: result.id },
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_capabilities",
  "Read-only capability sheet for Google Flow as driven by this server: modes, aspect ratios, durations, models, output counts, the watermark-removal engine, and where finished files are delivered. Consult it whenever a caller asks what Flow can do or which sizes/ratios are available.",
  {},
  async () => {
    try {
      return jsonResult({
        server: { name: "google-flow-mcp", version: "2.1.0" },
        modes: {
          video: {
            aspectRatios: FLOW_ASPECT_RATIOS,
            durations: FLOW_VIDEO_DURATIONS,
            models: FLOW_VIDEO_MODELS,
            defaultModel: videoConfig.defaultVideoModel,
            notes: "Reference images ride Flow's Ingredients drawer; the shared composer serializes submissions.",
          },
          image: {
            aspectRatios: FLOW_ASPECT_RATIOS,
            outputCount: [1, 2, 3, 4],
            referenceImages: "Same Ingredients drawer as video",
            notes: "Prompt is passed verbatim; no duration/model selection.",
          },
        },
        watermarkRemoval: {
          enabled: videoConfig.watermarkRemoval,
          method: videoConfig.watermarkMethod,
          engines: ["registered alpha-unblending (v3)", "OpenCV Navier-Stokes inpainting", "ffmpeg delogo"],
          verify: "Job records output.watermark { removed, method, durationMs }; delivered file is outputs/<job-id>/final/",
        },
        delivery: {
          layout: "outputs/<job-id>/final/video.mp4 | image.png",
          mcpField: "delivery.localPath (absolute path; watermarkRemoved flag included)",
          restAsset: "GET /v1/jobs/<id>/asset on the local asset API",
        },
        discovery: "Flow's live settings surface is probed at runtime; ratios/counts above were verified against the real UI (2026-09).",
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "get_video_status",
  "Compatibility alias for get_video_job. Checks durable local jobs first, then a legacy authenticated bridge request ID.",
  {
    requestId: z.string().describe("The request ID from generate_video"),
  },
  async ({ requestId }) => {
    try {
      const job = await videoOrchestrator.get(requestId);
      if (job) return jsonResult(publicVideoJob(job));
      return jsonResult({ legacyBridgeStatus: await flowController.getVideoStatus(requestId) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "get_video_job",
  "Get a durable video job, including state, progress timeline, prompt compilation, output, and QC result.",
  { jobId: z.string().uuid().describe("Video job ID returned by generate_video") },
  async ({ jobId }) => {
    try {
      const job = await videoOrchestrator.get(jobId);
      if (!job) return errorResult(new Error(`Video job ${jobId} was not found.`));
      return jsonResult(publicVideoJob(job));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "list_video_jobs",
  "List recent durable video jobs. This is local job history, not a remote Drive search.",
  { limit: z.number().int().min(1).max(100).default(25) },
  async ({ limit }) => {
    try {
      return jsonResult((await videoOrchestrator.list(limit)).map(publicVideoJob));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "cancel_video_job",
  "Request cancellation for a queued or active video job. It never starts another regeneration after cancellation.",
  { jobId: z.string().uuid() },
  async ({ jobId }) => {
    try {
      return jsonResult(publicVideoJob(await videoOrchestrator.cancel(jobId)));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "refine_video",
  "Create a new version from a prior job using a targeted creative directive while preserving unrelated approved details.",
  {
    jobId: z.string().uuid(),
    directive: z.string().min(3).max(4_000),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  },
  async ({ jobId, directive, priority }) => {
    try {
      return jsonResult(publicVideoJob(await videoOrchestrator.refine(jobId, directive, priority)));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "regenerate_video",
  "Create a new version of a prior job from its approved creative brief.",
  { jobId: z.string().uuid(), priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional() },
  async ({ jobId, priority }) => {
    try {
      return jsonResult(publicVideoJob(await videoOrchestrator.regenerate(jobId, priority)));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "recover_video_job",
  "Self-healing recovery for a job whose Flow generation finished but whose download failed or was interrupted. Reattaches to the open Flow tab, retrieves the already-paid clip, removes the watermark, and completes the job. Never submits a new generation, so no additional credits are spent.",
  { jobId: z.string().uuid().describe("Video job ID in a retrieval-failed state (DOWNLOAD_FAILED, RECOVERY_REQUIRED, GENERATED, or RETRIEVING)") },
  async ({ jobId }) => {
    try {
      return jsonResult(publicVideoJob(await videoOrchestrator.recoverRetrieval(jobId)));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "video_system_health",
  "Check local video-job persistence, queue availability, and browser-session availability without exposing credentials.",
  {},
  async () => {
    try {
      return jsonResult(await videoOrchestrator.health());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "download_flow_video",
  "Legacy manual download from an authorized Google asset URL or Drive ID. Completed orchestration jobs already download and validate their own asset.",
  {
    videoUrl: z.string().describe("Google Drive URL, file ID, or direct video URL"),
    outputPath: z.string().describe("Directory inside FLOW_OUTPUT_DIR where an authorized legacy download may be stored"),
    filename: z.string().optional().describe("Optional filename (default: original name or video.mp4)"),
  },
  async ({ videoUrl, outputPath, filename }) => {
    try {
      const savedPath = await flowController.downloadVideo(videoUrl, outputPath, filename);
      // Same finishing treatment as orchestrated jobs: the delivered file is
      // post-processed by default. Best-effort — a failed pass returns the
      // original download rather than losing the asset.
      if (videoConfig.watermarkRemoval) {
        try {
          const finished = await removeWatermarkFromVideo(savedPath, {
            outputPath: savedPath.replace(/(\.[^.]+)?$/, (ext) => `_clean${ext || ".mp4"}`),
            aspect: "16:9",
            method: videoConfig.watermarkMethod,
            pythonPath: videoConfig.pythonPath,
            ffmpegPath: videoConfig.ffmpegPath,
            scriptPath: videoConfig.watermarkScriptPath,
          });
          return jsonResult({ status: "completed", localPath: finished.outputPath, watermark: { removed: true, method: finished.method, durationMs: finished.durationMs } });
        } catch (err) {
          const normalized = asVideoSystemError(err);
          return jsonResult({ status: "completed", localPath: savedPath, watermark: { removed: false, error: normalized.message } });
        }
      }
      return jsonResult({ status: "completed", localPath: savedPath });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list_videos",
  "List all generated videos from Google Drive",
  {
    folderId: z.string().optional().describe("Google Drive folder ID to search in (default: all Drive)"),
  },
  async ({ folderId }) => {
    try {
      const videos = await flowController.listGeneratedVideos(folderId);
      return {
        content: [{
          type: "text" as const,
          text: videos.length > 0
            ? `🎬 Generated Videos (${videos.length}):\n${JSON.stringify(videos, null, 2)}`
            : "No videos found.",
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   GMAIL TOOLS (4 tools)                 ║
// ╚══════════════════════════════════════════╝

server.tool(
  "gmail_search",
  "Search Gmail using advanced query syntax (same as Gmail search bar)",
  {
    query: z.string().describe("Gmail search query (e.g., 'from:boss@company.com subject:urgent after:2025/01/01')"),
    maxResults: z.number().default(10).describe("Maximum number of results to return"),
  },
  async ({ query, maxResults }) => {
    try {
      const emails = await googleAPIs.searchEmails(query, maxResults);
      return {
        content: [{
          type: "text" as const,
          text: emails.length > 0
            ? `📧 Found ${emails.length} emails:\n${JSON.stringify(emails, null, 2)}`
            : `No emails found for query: "${query}"`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "gmail_read",
  "Read the full content of an email by its message ID",
  {
    messageId: z.string().describe("The Gmail message ID (from gmail_search results)"),
  },
  async ({ messageId }) => {
    try {
      const email = await googleAPIs.readEmail(messageId);
      return {
        content: [{
          type: "text" as const,
          text: [
            `📧 Email Details:`,
            `From: ${email.from}`,
            `To: ${email.to}`,
            `Subject: ${email.subject}`,
            `Date: ${email.date}`,
            email.cc ? `CC: ${email.cc}` : "",
            `\n--- Body ---\n${email.body}`,
            email.attachments.length > 0
              ? `\n📎 Attachments (${email.attachments.length}):\n${JSON.stringify(email.attachments, null, 2)}`
              : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "gmail_send",
  "Send an email via Gmail with optional CC and BCC",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (HTML supported)"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
    bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
  },
  async ({ to, subject, body, cc, bcc }) => {
    try {
      const result = await googleAPIs.sendEmail(to, subject, body, cc, bcc);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Email sent to ${to}\nSubject: ${subject}\nSent at: ${result.sentAt}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "gmail_reply",
  "Reply to an existing email thread",
  {
    messageId: z.string().describe("The message ID to reply to"),
    body: z.string().describe("Reply body (HTML supported)"),
  },
  async ({ messageId, body }) => {
    try {
      const replyId = await googleAPIs.replyToEmail(messageId, body);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Reply sent. New message ID: ${replyId}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   GOOGLE DRIVE TOOLS (5 tools)          ║
// ╚══════════════════════════════════════════╝

server.tool(
  "drive_list",
  "List files in Google Drive with optional folder, name, and type filters",
  {
    folderId: z.string().optional().describe("Drive folder ID to list (default: root)"),
    query: z.string().optional().describe("Search by filename"),
    fileType: z.string().optional().describe("Filter by MIME type (e.g., 'video/', 'image/', 'application/pdf')"),
  },
  async ({ folderId, query, fileType }) => {
    try {
      const files = await googleAPIs.listDriveFiles(folderId, query, fileType);
      return {
        content: [{
          type: "text" as const,
          text: files.length > 0
            ? `📁 Drive Files (${files.length}):\n${JSON.stringify(files, null, 2)}`
            : "No files found.",
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "drive_upload",
  "Upload a local file to Google Drive",
  {
    localPath: z.string().describe("Local file path to upload"),
    driveFolderId: z.string().optional().describe("Target Drive folder ID"),
    name: z.string().optional().describe("Name for the uploaded file (default: original filename)"),
  },
  async ({ localPath, driveFolderId, name }) => {
    try {
      const result = await googleAPIs.uploadFile(localPath, driveFolderId, name);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Uploaded to Drive:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "drive_download",
  "Download a file from Google Drive to a local path",
  {
    fileId: z.string().describe("Google Drive file ID"),
    localPath: z.string().describe("Local path to save the file (file or directory)"),
  },
  async ({ fileId, localPath }) => {
    try {
      const result = await googleAPIs.downloadFile(fileId, localPath);
      return {
        content: [{ type: "text" as const, text: `✅ Downloaded to: ${result}` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "drive_create_folder",
  "Create a new folder in Google Drive",
  {
    name: z.string().describe("Folder name"),
    parentId: z.string().optional().describe("Parent folder ID (default: root)"),
  },
  async ({ name, parentId }) => {
    try {
      const result = await googleAPIs.createDriveFolder(name, parentId);
      return {
        content: [{
          type: "text" as const,
          text: `📁 Folder created:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "drive_trash",
  "Move a file to trash in Google Drive",
  {
    fileId: z.string().describe("Google Drive file ID to trash"),
  },
  async ({ fileId }) => {
    try {
      const result = await googleAPIs.trashDriveFile(fileId);
      return {
        content: [{ type: "text" as const, text: `🗑️ ${result}` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   GOOGLE SHEETS TOOLS (4 tools)         ║
// ╚══════════════════════════════════════════╝

server.tool(
  "sheets_read",
  "Read data from a Google Sheets spreadsheet",
  {
    spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().describe("Cell range in A1 notation (e.g., 'Sheet1!A1:D10')"),
  },
  async ({ spreadsheetId, range }) => {
    try {
      const data = await googleAPIs.readSheet(spreadsheetId, range);
      return {
        content: [{
          type: "text" as const,
          text: `📊 Sheet Data (${data.rowCount} rows):\nRange: ${data.range}\n${JSON.stringify(data.values, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "sheets_write",
  "Write data to a Google Sheets spreadsheet (overwrites existing data in range)",
  {
    spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().describe("Cell range in A1 notation (e.g., 'Sheet1!A1')"),
    values: z.array(z.array(z.any())).describe("2D array of values to write (rows × columns)"),
  },
  async ({ spreadsheetId, range, values }) => {
    try {
      const result = await googleAPIs.writeSheet(spreadsheetId, range, values);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Data written:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "sheets_append",
  "Append rows to the end of a Google Sheets spreadsheet",
  {
    spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
    range: z.string().describe("Sheet name or range to append to (e.g., 'Sheet1')"),
    values: z.array(z.array(z.any())).describe("2D array of values to append"),
  },
  async ({ spreadsheetId, range, values }) => {
    try {
      const result = await googleAPIs.appendSheet(spreadsheetId, range, values);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Data appended:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "sheets_create",
  "Create a new Google Sheets spreadsheet",
  {
    title: z.string().describe("Spreadsheet title"),
    sheetNames: z.array(z.string()).optional().describe("Optional sheet/tab names to create"),
  },
  async ({ title, sheetNames }) => {
    try {
      const result = await googleAPIs.createSpreadsheet(title, sheetNames);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Spreadsheet created:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   GOOGLE DOCS TOOLS (3 tools)           ║
// ╚══════════════════════════════════════════╝

server.tool(
  "docs_create",
  "Create a new Google Docs document with optional initial content",
  {
    title: z.string().describe("Document title"),
    content: z.string().optional().describe("Initial text content for the document"),
  },
  async ({ title, content }) => {
    try {
      const result = await googleAPIs.createDoc(title, content);
      return {
        content: [{
          type: "text" as const,
          text: `📝 Document created:\nTitle: ${result.title}\nURL: ${result.url}\nID: ${result.documentId}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "docs_read",
  "Read the text content of a Google Docs document",
  {
    documentId: z.string().describe("Google Docs document ID"),
  },
  async ({ documentId }) => {
    try {
      const result = await googleAPIs.readDoc(documentId);
      return {
        content: [{
          type: "text" as const,
          text: [
            `📝 Document: ${result.title}`,
            `URL: ${result.url}`,
            `\n--- Content ---\n${result.text}`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "docs_append",
  "Append text to an existing Google Docs document",
  {
    documentId: z.string().describe("Google Docs document ID"),
    content: z.string().describe("Text content to append"),
  },
  async ({ documentId, content }) => {
    try {
      const result = await googleAPIs.appendToDoc(documentId, content);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Content appended to document ${documentId}.\nInserted at index: ${result.insertedAt}\nLength: ${result.contentLength} chars`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   GOOGLE CALENDAR TOOLS (4 tools)       ║
// ╚══════════════════════════════════════════╝

server.tool(
  "calendar_list_events",
  "List upcoming events from Google Calendar",
  {
    calendarId: z.string().default("primary").describe("Calendar ID (default: 'primary')"),
    timeMin: z.string().optional().describe("Start of time range (ISO 8601, e.g., '2025-01-01T00:00:00Z')"),
    timeMax: z.string().optional().describe("End of time range (ISO 8601)"),
    maxResults: z.number().default(10).describe("Maximum number of events to return"),
  },
  async ({ calendarId, timeMin, timeMax, maxResults }) => {
    try {
      const events = await googleAPIs.listCalendarEvents(calendarId, timeMin, timeMax, maxResults);
      return {
        content: [{
          type: "text" as const,
          text: events.length > 0
            ? `📅 Calendar Events (${events.length}):\n${JSON.stringify(events, null, 2)}`
            : "No upcoming events found.",
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "calendar_create_event",
  "Create a new Google Calendar event with optional attendees",
  {
    summary: z.string().describe("Event title/summary"),
    description: z.string().optional().describe("Event description"),
    startTime: z.string().describe("Start time (ISO 8601, e.g., '2025-06-15T10:00:00-07:00')"),
    endTime: z.string().describe("End time (ISO 8601)"),
    attendees: z.array(z.string()).optional().describe("Email addresses of attendees"),
    location: z.string().optional().describe("Event location"),
    timeZone: z.string().optional().describe("Time zone (e.g., 'America/Los_Angeles')"),
  },
  async ({ summary, description, startTime, endTime, attendees, location, timeZone }) => {
    try {
      const event = await googleAPIs.createCalendarEvent(
        summary,
        description,
        startTime,
        endTime,
        attendees,
        location,
        timeZone
      );
      return {
        content: [{
          type: "text" as const,
          text: `📅 Event created:\n${JSON.stringify(event, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "calendar_update_event",
  "Update an existing Google Calendar event",
  {
    eventId: z.string().describe("The event ID to update"),
    summary: z.string().optional().describe("New event title"),
    description: z.string().optional().describe("New description"),
    startTime: z.string().optional().describe("New start time (ISO 8601)"),
    endTime: z.string().optional().describe("New end time (ISO 8601)"),
    location: z.string().optional().describe("New location"),
  },
  async ({ eventId, summary, description, startTime, endTime, location }) => {
    try {
      const result = await googleAPIs.updateCalendarEvent(eventId, {
        summary,
        description,
        startTime,
        endTime,
        location,
      });
      return {
        content: [{
          type: "text" as const,
          text: `📅 Event updated:\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.tool(
  "calendar_delete_event",
  "Delete a Google Calendar event",
  {
    eventId: z.string().describe("The event ID to delete"),
  },
  async ({ eventId }) => {
    try {
      const result = await googleAPIs.deleteCalendarEvent(eventId);
      return {
        content: [{ type: "text" as const, text: `🗑️ ${result}` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// ╔══════════════════════════════════════════╗
// ║   BROWSER AUTOMATION TOOLS (6 tools)    ║
// ╚══════════════════════════════════════════╝

server.tool(
  "flow_browser_login",
  "Open the persistent browser profile at Google sign-in. Complete login manually; this MCP server never accepts, types, stores, or logs passwords, TOTP secrets, cookies, or one-time codes.",
  {},
  async () => {
    try {
      return jsonResult(await browserController.openLogin());
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_browser_autopilot",
  "Compatibility alias for a bounded, persistent Flow video job. It requires a manually authenticated persistent browser session and never automates password or MFA handling.",
  {
    prompt: z.string().min(3).max(8_000).describe("Director-style video instruction"),
    duration: z.enum(FLOW_VIDEO_DURATIONS).default("8s").describe("Clip length"),
    model: z.enum(FLOW_VIDEO_MODELS).default("gemini-omni-flash").describe("Flow model"),
    aspectRatio: z.enum(FLOW_ASPECT_RATIOS).default("16:9").describe("Frame aspect ratio — Flow offers 16:9, 4:3, 1:1, 3:4, 9:16"),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
    idempotencyKey: z.string().min(1).max(128).optional(),
    referenceImagePaths: z.array(z.string().min(1).max(4_096)).min(1).max(5).optional().describe("Absolute local PNG, JPEG, or WebP paths to attach as Google Flow Ingredients."),
    waitForCompletion: z.boolean().default(false),
  },
  async ({ prompt, duration, model, aspectRatio, priority, idempotencyKey, referenceImagePaths, waitForCompletion }) => {
    try {
      const job = await videoOrchestrator.submit(buildGenerationRequest({ prompt, duration, model, aspectRatio, priority, idempotencyKey, referenceImagePaths }));
      const result = waitForCompletion
        ? await videoOrchestrator.waitForTerminal(job.id, videoConfig.generationTimeoutMs + 30_000)
        : job;
      return jsonResult(publicVideoJob(result));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_browser_check_session",
  "Check if the Google browser session is still valid and active. " +
  "Returns the session state without navigating away from the current page.",
  {},
  async () => {
    try {
      const status = await browserController.checkLoginStatus();
      return jsonResult(status);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_browser_generate_video",
  "Compatibility alias for generate_video using the persistent job orchestrator. Requires a manually authenticated Google browser session.",
  {
    prompt: z.string().min(3).max(8_000).describe("Director-style video instruction"),
    duration: z.enum(FLOW_VIDEO_DURATIONS).default("8s").describe("Clip length"),
    model: z.enum(FLOW_VIDEO_MODELS).default("gemini-omni-flash").describe("Flow model"),
    aspectRatio: z.enum(FLOW_ASPECT_RATIOS).default("16:9").describe("Frame aspect ratio — Flow offers 16:9, 4:3, 1:1, 3:4, 9:16"),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
    idempotencyKey: z.string().min(1).max(128).optional(),
    referenceImagePaths: z.array(z.string().min(1).max(4_096)).min(1).max(5).optional().describe("Absolute local PNG, JPEG, or WebP paths to attach as Google Flow Ingredients."),
    waitForCompletion: z.boolean().default(false),
  },
  async ({ prompt, duration, model, aspectRatio, priority, idempotencyKey, referenceImagePaths, waitForCompletion }) => {
    try {
      const job = await videoOrchestrator.submit(buildGenerationRequest({ prompt, duration, model, aspectRatio, priority, idempotencyKey, referenceImagePaths }));
      const result = waitForCompletion
        ? await videoOrchestrator.waitForTerminal(job.id, videoConfig.generationTimeoutMs + 30_000)
        : job;
      return jsonResult(publicVideoJob(result));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_browser_action",
  "Execute a Google Flow action through browser automation (create, edit, run, export)",
  {
    action: z.enum(["create_flow", "edit_flow", "run_flow", "export_results", "navigate"]).describe("The action to perform"),
    flowName: z.string().describe("Name of the Flow to act on"),
    parameters: z.record(z.any()).optional().describe("Additional parameters for the action"),
  },
  async ({ action, flowName, parameters }) => {
    try {
      const result = await browserController.performAction(action, flowName, parameters);
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_screenshot",
  "Take a screenshot of the current browser page (useful for debugging)",
  {
    outputPath: z.string().optional().describe("Path to save the screenshot (default: ./screenshots/)"),
  },
  async ({ outputPath }) => {
    try {
      const screenshotPath = await browserController.takeScreenshot(outputPath);
      return jsonResult({ screenshotPath });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "flow_browser_close",
  "Close the browser automation session. Session data is preserved for next launch.",
  {},
  async () => {
    try {
      await browserController.close();
      return jsonResult({ status: "closed", message: "Browser session closed. Persistent session data remains in the configured profile directory." });
    } catch (err) {
      return errorResult(err);
    }
  }
);


// ╔══════════════════════════════════════════╗
// ║   MCP RESOURCES                         ║
// ╚══════════════════════════════════════════╝

server.resource(
  "workflows-list",
  "flow://workflows",
  async (uri) => {
    try {
      const flows = await flowController.listWorkflows();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(flows, null, 2),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: "Failed to fetch workflows. Check FLOW_BRIDGE_URL." }),
        }],
      };
    }
  }
);

server.resource(
  "videos-gallery",
  "flow://videos",
  async (uri) => {
    try {
      const videos = await flowController.listGeneratedVideos();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(videos, null, 2),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: "Failed to fetch videos." }),
        }],
      };
    }
  }
);

server.resource(
  "video-jobs",
  "flow://video-jobs",
  async (uri) => {
    try {
      const jobs = await videoOrchestrator.list(100);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(jobs.map(publicVideoJob), null, 2),
        }],
      };
    } catch (error) {
      const normalized = asVideoSystemError(error);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: { code: normalized.code, message: normalized.message } }),
        }],
      };
    }
  },
);

  captureToolCatalog(server);
  return server;
}

let toolCatalog: Array<{ name: string; description: string }> = [];

function captureToolCatalog(server: McpServer): void {
  // The SDK keeps the registry private; read it defensively so the /connect
  // page can list the tools without touching the 42 registration call sites.
  const registered = (server as unknown as { _registeredTools?: Record<string, { description?: string }> })._registeredTools;
  if (!registered) return;
  toolCatalog = Object.entries(registered).map(([name, tool]) => ({ name, description: tool.description ?? "" }));
}

/** Name + description of every tool registered by the most recent factory run. */
export function flowToolCatalog(): Array<{ name: string; description: string }> {
  return toolCatalog;
}
