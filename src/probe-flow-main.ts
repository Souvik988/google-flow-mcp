import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(moduleDirectory, ".."));
try {
  for (const envFile of [".env", process.env.FLOW_ENV_FILE ?? ".env.asset-studio"]) {
    const envPath = path.resolve(process.cwd(), envFile);
    if (fs.existsSync(envPath)) (process as never as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(envPath);
  }
} catch {
  // Ignored: fall through to defaults.
}

import { BrowserController } from "./browser-controller.js";
import { loadVideoSystemConfig } from "./video/config.js";

/** Read-only live probe: what does Flow's page actually expose right now? */
async function main(): Promise<void> {
  const config = loadVideoSystemConfig();
  const browser = new BrowserController(config);
  try {
    await browser.withPage(async (page) => {
      console.log("URL:", page.url().slice(0, 100));
      const info = await page.evaluate(() => {
        const visible = (element: Element) => {
          const style = window.getComputedStyle(element as HTMLElement);
          const bounds = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
        };
        const videos = Array.from(document.querySelectorAll("video")).map((video) => ({
          src: (video.currentSrc || video.src || "").slice(0, 120),
          readyState: video.readyState,
        }));
        const tiles = document.querySelectorAll("flow-video-tile").length;
        const batches = document.querySelectorAll(".batch-container").length;
        const controls = Array.from(document.querySelectorAll("button, [role=button], a[download]"))
          .filter(visible)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            aria: element.getAttribute("aria-label") ?? "",
            text: ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").slice(0, 60),
          }))
          .filter((control) => /download|save/i.test(`${control.aria} ${control.text}`))
          .slice(0, 12);
        return { videos, tiles, batches, controls };
      });
      console.log(JSON.stringify(info, null, 2));
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[probe] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
