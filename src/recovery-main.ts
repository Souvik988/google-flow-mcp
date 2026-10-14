import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Same environment contract as asset-mcp-main.ts: resolve the project root and
// load its env files no matter where the operator launched this from.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(moduleDirectory, ".."));
try {
  for (const envFile of [".env", process.env.FLOW_ENV_FILE ?? ".env.asset-studio"]) {
    const envPath = path.resolve(process.cwd(), envFile);
    if (fs.existsSync(envPath)) (process as never as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(envPath);
  }
} catch {
  // Missing env file falls through to defaults / already-set variables.
}

import { BrowserController } from "./browser-controller.js";
import { AssetManager } from "./video/asset-manager.js";
import { loadVideoSystemConfig } from "./video/config.js";
import { recoverVideoJob } from "./video/job-recovery.js";
import { VideoJobStore } from "./video/job-store.js";

/**
 * Standalone operator entry: `node dist/recovery-main.js <jobId>`
 * Resumes asset retrieval for a GENERATED/RETRIEVING job whose download
 * failed, then completes QC + watermark removal + finalize. Read-only with
 * respect to Flow credits: no new generation is submitted.
 */
async function main(): Promise<void> {
  const jobId = process.argv[2] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error("Usage: node dist/recovery-main.js <jobId>");
  }
  const config = loadVideoSystemConfig();
  const store = new VideoJobStore(config.stateDir);
  await store.initialize();
  const browser = new BrowserController(config);
  const assets = new AssetManager(config.outputDir);
  try {
    await recoverVideoJob(jobId, store, browser, assets, config);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[recover] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
