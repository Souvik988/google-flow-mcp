import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BrowserController } from "./browser-controller.js";
import { assetStudioHtml } from "./asset-studio.js";
import { buildConnectPageHtml } from "./connect-page.js";
import { flowToolCatalog } from "./mcp-server.js";
import type { VideoSystemConfig } from "./video/config.js";
import { asVideoSystemError, VideoSystemError } from "./video/errors.js";
import { VideoOrchestrator } from "./video/orchestrator.js";
import type { VideoJob } from "./video/types.js";
import { FLOW_VIDEO_DURATIONS, FLOW_VIDEO_MODELS } from "./video/types.js";

const createJobSchema = z.object({
  prompt: z.string().min(3).max(8_000),
  duration: z.enum(FLOW_VIDEO_DURATIONS).default("8s"),
  model: z.enum(FLOW_VIDEO_MODELS).default("gemini-omni-flash"),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "3:4", "4:3"]).default("16:9"),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
  idempotencyKey: z.string().min(1).max(128).optional(),
  qualityTarget: z.enum(["standard", "high"]).default("standard"),
  referenceImagePaths: z.array(z.string().min(1).max(4_096)).min(1).max(5).optional(),
  kind: z.enum(["video", "image"]).default("video"),
  outputCount: z.number().int().min(1).max(4).optional(),
});
const refineSchema = z.object({ directive: z.string().min(3).max(4_000), priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional() });

function publicJob(job: VideoJob) {
  return {
    jobId: job.id, parentJobId: job.parentJobId, status: job.state, priority: job.priority,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
    lastProgressAt: job.lastProgressAt, attempts: job.attempts, output: job.output,
    delivery: deliveryFor(job),
    quality: job.quality, error: job.error, events: job.events,
    referenceImages: job.request.referenceImagePaths?.length
      ? { mode: job.request.referenceMode ?? "ingredients", count: job.request.referenceImagePaths.length }
      : undefined,
    creativeBrief: job.creativeBrief, compiledPrompt: job.compiledPrompt,
  };
}

/** Absolute local file coordinates so IDE agents can open the clip directly. */
export function deliveryFor(job: VideoJob) {
  if (!job.output?.finalPath) return undefined;
  return {
    localPath: job.output.finalPath,
    fileName: path.basename(job.output.finalPath),
    directory: job.output.rootDir,
    watermarkRemoved: job.output.watermark?.removed === true,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new VideoSystemError("PATH_VALIDATION_FAILED", "Request body exceeds 64 KB.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new VideoSystemError("PATH_VALIDATION_FAILED", "Request body must be valid JSON."); }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(html);
}

function sendStudio(response: ServerResponse): void {
  sendHtml(response, assetStudioHtml);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function equalConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

export interface AssetApiDependencies {
  config: VideoSystemConfig;
  browser: BrowserController;
  videos: VideoOrchestrator;
  /** When set, a streamable-HTTP MCP endpoint is mounted at /mcp next to the REST API. */
  mcpServerFactory?: () => McpServer;
}

/** Local authenticated HTTP facade over the same durable video engine as MCP. */
export async function startAssetApi(dependencies: AssetApiDependencies): Promise<Server> {
  const { config, browser, videos } = dependencies;
  if (!config.httpToken) throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_HTTP_TOKEN is required when the HTTP asset API is enabled.");
  if (config.httpHost !== "127.0.0.1" && config.httpHost !== "localhost") {
    throw new VideoSystemError("CONFIGURATION_ERROR", "The asset API only supports loopback binding. Put remote access behind your own authenticated reverse proxy.");
  }

  let mcpTransport: StreamableHTTPServerTransport | undefined;
  if (dependencies.mcpServerFactory) {
    mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await dependencies.mcpServerFactory().connect(mcpTransport);
  }

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) return send(response, 404, { error: { code: "NOT_FOUND" } });
      const url = new URL(request.url, `http://${config.httpHost}`);
      const method = request.method ?? "GET";
      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return sendStudio(response);
      if (method === "GET" && (url.pathname === "/connect" || url.pathname === "/connect.html")) {
        return sendHtml(response, buildConnectPageHtml({
          serverName: "Google Flow MCP",
          serverVersion: "2.0.0",
          mcpUrl: `http://${config.httpHost}:${config.httpPort}/mcp`,
          httpBaseUrl: `http://${config.httpHost}:${config.httpPort}`,
          transport: config.transport,
          workspaceRoot: config.workspaceRoot,
          outputDir: config.outputDir,
          watermarkRemoval: config.watermarkRemoval,
          watermarkMethod: config.watermarkMethod,
          tokenRequired: true,
          tokenEnvVar: "FLOW_HTTP_TOKEN",
          tools: flowToolCatalog(),
          stdioEntry: path.join(config.workspaceRoot, "dist", "index.js"),
        }));
      }
      if (!equalConstantTime(bearerToken(request) ?? "", config.httpToken!)) {
        return send(response, 401, { error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." } });
      }
      if (url.pathname === "/mcp") {
        if (!mcpTransport) return send(response, 503, { error: { code: "MCP_HTTP_DISABLED", message: "The MCP HTTP endpoint is not enabled on this server." } });
        // The transport validates the initialize handshake and session id,
        // then writes the JSON-RPC response itself.
        await mcpTransport.handleRequest(request, response);
        return;
      }
      const match = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(cancel|refine|regenerate|asset))?$/i);

      if (method === "GET" && url.pathname === "/v1/health") return send(response, 200, await videos.health());
      if (method === "POST" && url.pathname === "/v1/session/login") return send(response, 200, await browser.openLogin());
      if (method === "GET" && url.pathname === "/v1/session") return send(response, 200, await browser.checkLoginStatus());
      if (method === "POST" && url.pathname === "/v1/jobs") {
        const input = createJobSchema.parse(await readJson(request));
        const job = await videos.submit({
          instruction: input.prompt, duration: input.duration, model: input.model, aspectRatio: input.aspectRatio,
          priority: input.priority, idempotencyKey: input.idempotencyKey, qualityTarget: input.qualityTarget,
          referenceImagePaths: input.referenceImagePaths, kind: input.kind, outputCount: input.outputCount,
        });
        return send(response, 202, publicJob(job));
      }
      if (method === "GET" && url.pathname === "/v1/jobs") {
        const limit = z.coerce.number().int().min(1).max(100).catch(25).parse(url.searchParams.get("limit") ?? "25");
        return send(response, 200, (await videos.list(limit)).map(publicJob));
      }
      if (match) {
        const [, jobId, action] = match;
        if (!action && method === "GET") {
          const job = await videos.get(jobId);
          return job ? send(response, 200, publicJob(job)) : send(response, 404, { error: { code: "NOT_FOUND" } });
        }
        if (action === "cancel" && method === "POST") return send(response, 200, publicJob(await videos.cancel(jobId)));
        if (action === "refine" && method === "POST") {
          const input = refineSchema.parse(await readJson(request));
          return send(response, 202, publicJob(await videos.refine(jobId, input.directive, input.priority)));
        }
        if (action === "regenerate" && method === "POST") {
          const input = z.object({ priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional() }).parse(await readJson(request));
          return send(response, 202, publicJob(await videos.regenerate(jobId, input.priority)));
        }
        if (action === "asset" && method === "GET") {
          const job = await videos.get(jobId);
          if (!job?.output?.finalPath || !fs.existsSync(job.output.finalPath)) return send(response, 404, { error: { code: "ASSET_NOT_READY" } });
          const stat = fs.statSync(job.output.finalPath);
          response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": stat.size, "Cache-Control": "private, no-store" });
          const file = fs.createReadStream(job.output.finalPath);
          file.once("error", () => response.destroy());
          file.pipe(response);
          return;
        }
      }
      return send(response, 404, { error: { code: "NOT_FOUND" } });
    } catch (error) {
      const normalized = asVideoSystemError(error);
      const status = normalized.code === "PATH_VALIDATION_FAILED" ? 400 : normalized.code === "AUTH_REQUIRED" ? 409 : 500;
      // The MCP transport writes its own JSON-RPC error responses; never try
      // to send a second body after it has already taken over the response.
      if (response.headersSent) return response.end();
      return send(response, status, { error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable } });
    }
  });
  server.once("close", () => void mcpTransport?.close());
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(config.httpPort, config.httpHost, resolve));
  return server;
}
