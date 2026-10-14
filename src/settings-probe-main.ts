import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Page } from "puppeteer";

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

void BrowserController;
void loadVideoSystemConfig;

/** Dump the settings panel's real vocabulary: all labeled groups + their options. */
async function dumpSettings(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const bounds = html.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const result: Record<string, string[]> = {};
    // Capture every aria-labeled element that contains selectable controls.
    for (const element of Array.from(document.querySelectorAll("[aria-label]"))) {
      if (!visible(element)) continue;
      const label = (element.getAttribute("aria-label") ?? "").trim();
      if (!label || label.length > 60) continue;
      const inside = Array.from(element.querySelectorAll("button, [role=radio], [role=option], mat-button-toggle"))
        .filter(visible)
        .map((choice) => {
          const semantic = (choice as HTMLElement).querySelector(".toggle-text")?.textContent;
          return (semantic || (choice as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        })
        .filter((text) => text.length > 0 && text.length < 50);
      if (inside.length) {
        const key = result[label] ? `${label}#${Object.keys(result).filter((k) => k.startsWith(label)).length}` : label;
        result[key] = inside;
      }
    }
    return result;
  });
}

async function main(): Promise<void> {
  const config = loadVideoSystemConfig();
  const browser = new BrowserController(config);
  try {
    await browser.withPage(async (page: Page) => {
      // The settings surface only exists inside a project; navigate into the
      // most recently used one (read-only navigation, no generation).
      const current = page.url();
      if (!current.includes("/project/")) {
        await page.goto("https://flow.google.com/project/14ace56d-84b4-4a41-b433-cba326da17b5", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
      console.log("URL:", page.url().slice(0, 90));
      const opened = await page.evaluate(() => {
        const control = Array.from(document.querySelectorAll("button, [role=button]")).find(
          (element) => element.getAttribute("aria-label") === "Settings trigger",
        ) as HTMLElement | undefined;
        if (!control) return false;
        control.click();
        return true;
      });
      if (!opened) throw new Error("Settings trigger not found.");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      console.log("\n=== ALL settings groups (video mode default) ===");
      console.log(JSON.stringify(await dumpSettings(page), null, 1));
      await page.keyboard.press("Escape").catch(() => undefined);
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
