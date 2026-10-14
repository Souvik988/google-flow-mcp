import path from "path";
import fs from "fs";
import type { Server as HttpServer } from "http";

// Automatically load .env file if available
try {
  const envPaths = [".env", process.env.FLOW_ENV_FILE].filter((value): value is string => Boolean(value));
  for (const envFile of envPaths) {
    const envPath = path.resolve(process.cwd(), envFile);
    if (fs.existsSync(envPath)) (process as any).loadEnvFile?.(envPath);
  }
} catch {
  // Ignored if .env does not exist or already set via environment
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlowController } from "./flow-controller.js";
import { GoogleAPIs } from "./google-apis.js";
import { BrowserController } from "./browser-controller.js";
import { createFlowMcpServer, flowToolCatalog } from "./mcp-server.js";
import { startAssetApi } from "./http-api.js";
import { logger } from "./utils.js";
import { loadVideoSystemConfig } from "./video/config.js";
import { VideoOrchestrator } from "./video/orchestrator.js";

// ============================================
// SERVER INITIALIZATION
// ============================================

const videoConfig = loadVideoSystemConfig();
const flowController = new FlowController();
const googleAPIs = new GoogleAPIs();
const browserController = new BrowserController(videoConfig);
const videoOrchestrator = new VideoOrchestrator(browserController, videoConfig);
const mcpDependencies = { config: videoConfig, flows: flowController, apis: googleAPIs, browser: browserController, videos: videoOrchestrator };
const server = createFlowMcpServer(mcpDependencies);

// ║   SERVER STARTUP                        ║
// ╚══════════════════════════════════════════╝

async function main() {
  await videoOrchestrator.initialize();
  logger.info("Starting Google Flow MCP Server v2.0.0");
  logger.info(`Tools registered: ${flowToolCatalog().length}`);
  logger.info(`Resources registered: 3`);

  let assetApi: HttpServer | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down...");
    await videoOrchestrator.shutdown();
    await browserController.close();
    if (assetApi) await new Promise<void>((resolve) => assetApi!.close(() => resolve()));
  };
  const exitOnSignal = (signal: string) => {
    void shutdown().finally(() => process.exit(0));
    logger.info(`Received ${signal}`);
  };
  process.once("SIGINT", () => exitOnSignal("SIGINT"));
  process.once("SIGTERM", () => exitOnSignal("SIGTERM"));

  if (videoConfig.transport !== "stdio") {
    assetApi = await startAssetApi({ config: videoConfig, browser: browserController, videos: videoOrchestrator, mcpServerFactory: () => createFlowMcpServer(mcpDependencies) });
    logger.info(`Local asset API running on http://${videoConfig.httpHost}:${videoConfig.httpPort}/v1`);
  }
  if (videoConfig.transport !== "http") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Google Flow MCP Server running on stdio");
  }
}

main().catch((err) => {
  logger.error("Fatal error starting server", err);
  process.exit(1);
});
