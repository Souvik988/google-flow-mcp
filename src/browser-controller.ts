import fs from "fs/promises";
import path from "path";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";
import { logger } from "./utils.js";
import { openCleanSignInChrome, openManualChrome, waitForSignInWindowClose } from "./manual-chrome.js";
import { VideoSystemError } from "./video/errors.js";
import { loadVideoSystemConfig, type VideoSystemConfig } from "./video/config.js";

export interface VideoGenOptions {
  prompt: string;
  duration?: "4s" | "6s" | "8s" | "10s";
  aspectRatio?: "16:9" | "9:16" | "1:1";
  outputDir?: string;
  maxWaitMs?: number;
}

export interface VideoGenResult {
  status: "completed" | "timeout" | "failed";
  localPath?: string;
  message: string;
  screenshotPath?: string;
}

export type SessionState = "valid" | "expired" | "unavailable" | "error";

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

/**
 * Owns a single persistent, user-authenticated browser profile. It deliberately
 * does not accept, read, type, or log passwords, TOTP secrets, cookies, or login
 * codes. Authentication is completed by the user in the visible browser once.
 */
export class BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private ownsBrowser = false;
  private readonly mutex = new AsyncMutex();
  private readonly config: VideoSystemConfig;
  private shuttingDown = false;

  constructor(config: VideoSystemConfig = loadVideoSystemConfig()) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    await this.withPage(async () => undefined);
  }

  async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => operation(await this.ensurePage()));
  }

  /**
   * Holds the profile/page lock for one complete provider job. Long-running
   * generation monitoring intentionally prevents another job from navigating
   * the same account tab into a conflicting UI state.
   */
  async withExclusiveJob<T>(jobId: string, operation: (page: Page) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      logger.info("Browser job lease acquired", { jobId });
      try {
        return await operation(await this.ensurePage());
      } finally {
        logger.info("Browser job lease released", { jobId });
      }
    });
  }

  async configureDownloads(page: Page, directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: directory,
      eventsEnabled: true,
    });
  }

  async validateSession(): Promise<SessionState> {
    try {
      return await this.withPage(async () => {
        if (!this.browser?.connected) return "unavailable";
        const probe = await this.browser.newPage();
        try {
          await probe.goto("https://myaccount.google.com/", {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          const url = probe.url();
          return url.includes("myaccount.google.com") && !url.includes("signin") ? "valid" : "expired";
        } finally {
          await probe.close().catch(() => undefined);
        }
      });
    } catch (error) {
      logger.warn("Browser session validation failed", { error: error instanceof Error ? error.message : String(error) });
      return "error";
    }
  }

  async openLogin(): Promise<{ state: SessionState; message: string }> {
    if (this.config.browserCdpUrl) {
      // Google blocks fresh sign-ins inside any DevTools-enabled Chrome
      // ("This browser or app may not be secure"). Hand the SAME profile to a
      // clean Chrome (no debugging port) for the manual sign-in, wait for the
      // operator to close it, then reconnect automation to the profile.
      await this.disconnect();
      logger.info("Opening a clean Chrome window for Google sign-in; automation reattaches after it closes");
      const { child } = await openCleanSignInChrome(this.config);
      await waitForSignInWindowClose(child);
    }
    return this.withPage(async (page) => {
      await page.goto("https://accounts.google.com/signin", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const state = await this.validateSessionWithinLock();
      return {
        state,
        message:
          state === "valid"
            ? "Google browser session is already active."
            : "A visible Google sign-in page is open. Complete authentication manually; credentials are never accepted or stored by this server.",
      };
    });
  }

  /** Legacy compatibility entry point. Credentials are intentionally ignored. */
  async login(_deprecatedCredentials?: unknown): Promise<string> {
    const result = await this.openLogin();
    return result.message;
  }

  async checkLoginStatus(): Promise<{ loggedIn: boolean; details: string }> {
    const state = await this.validateSession();
    return {
      loggedIn: state === "valid",
      details:
        state === "valid"
          ? "Google session is active and valid."
          : state === "expired"
            ? "Google session needs manual re-authentication. Use flow_browser_login to open the sign-in page."
            : `Browser session state: ${state}.`,
    };
  }

  async requireAuthenticatedSession(): Promise<void> {
    const state = await this.validateSession();
    if (state !== "valid") {
      throw new VideoSystemError(
        "AUTH_REQUIRED",
        "Google authentication is required. Run flow_browser_login and complete sign-in in the persistent browser profile.",
      );
    }
  }

  async takeScreenshot(outputPath?: string): Promise<string> {
    const defaultDirectory = path.join(this.config.workspaceRoot, "screenshots", "manual");
    const target = outputPath
      ? path.resolve(outputPath)
      : path.join(defaultDirectory, `flow-${Date.now()}.png`);
    const relative = path.relative(this.config.workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", "Screenshots must be saved within this workspace.");
    }
    return this.withPage(async (page) => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: true, type: "png" });
      return target;
    });
  }

  async captureDiagnostic(page: Page, jobId: string, reason: string): Promise<string | undefined> {
    if (!this.config.captureDiagnostics) return undefined;
    const directory = path.join(this.config.outputDir, jobId, "qc", "diagnostics");
    const target = path.join(directory, `${reason}-${Date.now()}.png`);
    await fs.mkdir(directory, { recursive: true });
    await page.screenshot({ path: target, fullPage: true, type: "png" });
    return target;
  }

  /** Safe, deliberately narrow legacy browser actions. */
  async performAction(
    action: "create_flow" | "edit_flow" | "run_flow" | "export_results" | "navigate",
    flowName: string,
    parameters?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.requireAuthenticatedSession();
    return this.withPage(async (page) => {
      if (action === "create_flow") {
        await page.goto("https://workspace.google.com/studio/flow/create", { waitUntil: "domcontentloaded", timeout: 30_000 });
        const input = await findFirstVisible(page, [
          '[data-testid="flow-name-input"]',
          'input[aria-label*="name" i]',
          'input[placeholder*="name" i]',
        ]);
        await input.click();
        await page.keyboard.type(flowName);
        return { status: "create_initiated", flowName, descriptionProvided: Boolean(parameters?.description), url: page.url() };
      }

      await page.goto("https://workspace.google.com/studio/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      const search = await findFirstVisible(page, [
        '[data-testid="search-input"]',
        'input[aria-label*="search" i]',
        'input[type="search"]',
      ]);
      await search.click();
      await page.keyboard.type(flowName);
      await page.keyboard.press("Enter");

      if (action === "navigate" || action === "edit_flow") {
        return { status: action === "navigate" ? "navigated" : "edit_initiated", flowName, url: page.url() };
      }

      const label = action === "run_flow" ? /\brun\b/i : /\b(?:export|download)\b/i;
      const clicked = await clickByAccessibleText(page, label);
      if (!clicked) {
        throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", `Could not find a ${action === "run_flow" ? "Run" : "Export"} control.`);
      }
      return { status: action === "run_flow" ? "run_initiated" : "export_initiated", flowName, url: page.url() };
    });
  }

  /** Removed insecure one-shot flow. The MCP job orchestrator owns video state. */
  async generateVideoViaUI(_options: VideoGenOptions): Promise<VideoGenResult> {
    return {
      status: "failed",
      message: "Direct browser generation is retired. Use the generate_video MCP tool, which creates a persistent, observable job.",
    };
  }

  async autopilotVideoPipeline(options: VideoGenOptions): Promise<VideoGenResult> {
    return this.generateVideoViaUI(options);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    await this.disconnect();
  }

  /** Releases the browser attach WITHOUT ending the manager's lifetime, so a
   * later ensurePage() can reconnect — used by the clean sign-in dance. */
  private async disconnect(): Promise<void> {
    await this.mutex.run(async () => {
      const browser = this.browser;
      const ownsBrowser = this.ownsBrowser;
      this.browser = null;
      this.page = null;
      this.ownsBrowser = false;
      if (ownsBrowser) await browser?.close().catch(() => undefined);
      else browser?.disconnect();
    });
  }

  get connected(): boolean {
    return Boolean(this.browser?.connected);
  }

  private async ensurePage(): Promise<Page> {
    if (this.shuttingDown) throw new VideoSystemError("BROWSER_DISCONNECTED", "Browser manager is shutting down.");
    if (this.page && this.browser?.connected) {
      try {
        await this.page.evaluate(() => document.readyState);
        return this.page;
      } catch {
        if (this.ownsBrowser) await this.browser.close().catch(() => undefined);
        else this.browser.disconnect();
        this.browser = null;
        this.page = null;
        this.ownsBrowser = false;
      }
    }

    if (this.config.browserCdpUrl) {
      await openManualChrome(this.config);
      this.browser = await puppeteer.connect({ browserURL: this.config.browserCdpUrl, protocolTimeout: 120_000 });
      this.ownsBrowser = false;
    } else {
      await fs.mkdir(this.config.browserProfileDir, { recursive: true });
      const launch = puppeteer.launch({
        headless: this.config.headless,
        userDataDir: this.config.browserProfileDir,
        defaultViewport: { width: 1440, height: 960 },
        protocolTimeout: 120_000,
        args: ["--window-size=1440,960", "--lang=en-US,en"],
      });
      let timedOut = false;
      let timeoutId: NodeJS.Timeout | undefined;
      const launchTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new VideoSystemError("BROWSER_DISCONNECTED", `Browser startup did not finish within ${this.config.browserLaunchTimeoutMs} ms. Close any other browser using the configured Flow profile, then retry.`, { retryable: true }));
        }, this.config.browserLaunchTimeoutMs);
      });
      try {
        this.browser = await Promise.race([launch, launchTimeout]);
        this.ownsBrowser = true;
      } catch (error) {
        if (timedOut) void launch.then((browser) => browser.close()).catch(() => undefined);
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    this.browser.on("disconnected", () => {
      this.browser = null;
      this.page = null;
      logger.warn("Browser disconnected");
    });
    const pages = await this.browser.pages();
    // A normal user Chrome profile can have a blank/new-tab page before the
    // authenticated Flow tab. Prefer a real Flow project so the provider does
    // not attempt to resolve controls against chrome://newtab.
    this.page = pages.find((candidate) => {
      try {
        const url = new URL(candidate.url());
        return /(^|\.)google\.com$/.test(url.hostname) && url.hostname === "flow.google.com" && url.pathname.includes("/project/");
      } catch {
        return false;
      }
    }) ?? pages.find((candidate) => {
      try { return new URL(candidate.url()).hostname === "flow.google.com"; }
      catch { return false; }
    }) ?? pages[0] ?? (await this.browser.newPage());
    await this.page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    logger.info("Persistent browser session started", { headless: this.config.headless });
    return this.page;
  }

  private async validateSessionWithinLock(): Promise<SessionState> {
    if (!this.browser?.connected) return "unavailable";
    const probe = await this.browser.newPage();
    try {
      await probe.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      const url = probe.url();
      return url.includes("myaccount.google.com") && !url.includes("signin") ? "valid" : "expired";
    } finally {
      await probe.close().catch(() => undefined);
    }
  }
}

export async function findFirstVisible(page: Page, selectors: string[]): Promise<ElementHandle> {
  for (const selector of selectors) {
    const candidate = await page.$(selector);
    if (!candidate) continue;
    const visible = await candidate.evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      return style.visibility !== "hidden" && style.display !== "none" && htmlElement.getBoundingClientRect().width > 0 && htmlElement.getBoundingClientRect().height > 0;
    });
    if (visible) return candidate;
  }
  throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", "No expected visible control was found.", {
    retryable: true,
    details: { selectorCount: selectors.length },
  });
}

export async function clickByAccessibleText(page: Page, pattern: RegExp): Promise<boolean> {
  return page.evaluate((serializedPattern) => {
    const expression = new RegExp(serializedPattern.source, serializedPattern.flags);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a[download]'));
    const target = controls.find((control) => {
      const element = control as HTMLElement;
      const label = element.getAttribute("aria-label") ?? "";
      const text = element.innerText ?? element.textContent ?? "";
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && expression.test(`${label} ${text}`.trim());
    }) as HTMLElement | undefined;
    if (!target) return false;
    target.click();
    return true;
  }, { source: pattern.source, flags: pattern.flags });
}
