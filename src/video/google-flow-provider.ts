import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { BrowserController, clickByAccessibleText, findFirstVisible } from "../browser-controller.js";
import { sleep } from "../utils.js";
import { AssetManager, type JobDirectories } from "./asset-manager.js";
import { isTrustedFlowHost, type VideoSystemConfig } from "./config.js";
import { VideoSystemError } from "./errors.js";
import type { AssetRetrievalResult, FlowReferenceMode, FlowVideoDuration, FlowVideoModel, ProviderObservation, ProviderSubmission } from "./types.js";

interface GenerationSnapshot {
  videoSources: string[];
  imageSources: string[];
  downloadControls: number;
  progressSignature: string;
  hasProgress: boolean;
  errorMessage?: string;
}

interface ActiveGeneration {
  jobId: string;
  baseline: GenerationSnapshot;
  sourceUrl?: string;
}

export interface BrowserGenerationOptions {
  prompt: string;
  /** Image renders ignore duration and model. */
  duration?: FlowVideoDuration;
  model?: FlowVideoModel;
  aspectRatio: "16:9" | "9:16" | "1:1" | "3:4" | "4:3";
  referenceImagePaths: string[];
  referenceMode?: FlowReferenceMode;
  /** Defaults to "video". */
  kind?: "video" | "image";
  /** Image mode only: 1-4 variations. */
  outputCount?: number;
  maxWaitMs: number;
  isCancelled: () => Promise<boolean>;
  onProgress: (event: string, details?: Record<string, unknown>) => Promise<void>;
}

/**
 * The only component that knows Flow's UI. Selector candidates originate from
 * the repository's observed UI integration and are intentionally centralized.
 */
export class GoogleFlowBrowserProvider {
  private readonly active = new Map<string, ActiveGeneration>();

  constructor(
    private readonly browser: BrowserController,
    private readonly assets: AssetManager,
    private readonly config: VideoSystemConfig,
  ) {}

  async generate(
    jobId: string,
    options: BrowserGenerationOptions,
    directories: JobDirectories,
  ): Promise<AssetRetrievalResult & ProviderSubmission> {
    await this.browser.requireAuthenticatedSession();
    try {
      return await this.browser.withExclusiveJob(jobId, async (page) => {
      if (await options.isCancelled()) {
        throw new VideoSystemError("CANCELLED", "Video job was cancelled before Flow submission.");
      }
      await this.browser.configureDownloads(page, directories.temporary);
      await this.openStudio(page);
      await this.enterPrompt(page, options.prompt);
      await this.configureOutput(page, options);
      if (options.referenceImagePaths.length) {
        await this.attachReferenceImages(page, options.referenceImagePaths, options.referenceMode ?? "ingredients", options);
      }
      const baseline = await inspectGenerationSurface(page);
      const reference = jobId;
      this.active.set(reference, { jobId, baseline });

      // Image tiles can take longer than 20s to mount (Nano Banana queue);
      // the ack window scales with the render kind.
      await this.submit(page, baseline, options.kind === "image" ? 90_000 : 20_000);
      await options.onProgress("generation_submitted", { providerReference: reference });
      const observation = await this.waitForGeneration(page, reference, options);
      const result = await this.retrieveAsset(page, reference, observation, directories, options);
      this.active.delete(reference);
      return { reference, ...result };
      });
    } catch (error) {
      if (error instanceof Error && /Runtime\.callFunctionOn timed out|protocol timeout/i.test(error.message)) {
        throw new VideoSystemError(
          "BROWSER_DISCONNECTED",
          "Flow stopped responding to the local browser bridge. No successful submission was assumed; retry once the Flow page is responsive.",
          { retryable: true },
        );
      }
      throw error;
    }
  }

  private async openStudio(page: Page): Promise<void> {
    await page.goto(this.config.flowStudioUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const url = new URL(page.url());
    if (!isTrustedFlowHost(url.hostname)) {
      throw new VideoSystemError("FLOW_UI_CHANGED", "Flow browser was redirected to an unexpected site.");
    }
    if (url.hostname === "accounts.google.com" || url.pathname.includes("signin") || url.pathname.includes("/about")) {
      throw new VideoSystemError("AUTH_REQUIRED", "Google session needs manual re-authentication. Use the Studio sign-in control in the persistent browser profile.");
    }
    try {
      await this.waitForPrompt(page, 10_000);
    } catch {
      const created = await clickByAccessibleText(page, /\b(?:new project|create project|add new project)\b/i);
      if (!created) {
        await page.evaluate(() => {
          const btn = document.querySelector("button.new-project-button, button[aria-label*='project' i]");
          if (btn) (btn as HTMLElement).click();
        });
      }
      await this.waitForPrompt(page, 15_000);
    }
  }

  private async enterPrompt(page: Page, prompt: string): Promise<void> {
    const input = await this.waitForPrompt(page, 10_000);
    // Flow's ProseMirror composer accepts keyboard input only after a real
    // focus transition; a generic element click can leave its document model
    // unchanged while the DOM appears selected.
    await input.focus();
    const isRichComposer = await input.evaluate((element) => element.getAttribute("contenteditable") === "true");
    // A fresh Flow project has an empty ProseMirror composer. Ctrl+A is
    // captured by Flow's global shortcut handler and prevents subsequent
    // typing, so do not use the plain-input clearing sequence there.
    if (!isRichComposer) {
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
    }
    if (isRichComposer) {
      // ProseMirror consumes a Chromium text-insertion event more reliably
      // than individual synthetic key presses.
      await page.keyboard.sendCharacter(prompt);
    } else {
      await page.keyboard.type(prompt);
    }
    const entered = await input.evaluate((element) => {
      const html = element as HTMLInputElement | HTMLTextAreaElement;
      return html.value || html.textContent || "";
    });
    if (!entered.trim()) {
      throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", "Flow prompt field did not retain the compiled prompt.", { retryable: true });
    }
  }

  private async configureOutput(page: Page, options: BrowserGenerationOptions): Promise<void> {
    const isImage = options.kind === "image";
    // New Flow projects open in Image mode. Video duration controls do not
    // exist until Video mode is selected, and image count controls do not
    // exist until Image mode is. The Aspect ratio group exists in both.
    await openSettings(page);
    try {
      if (isImage) {
        await selectToggle(page, "Mode", /^\s*(?:image\s*)?image\s*$/i, "Image mode");
        await selectToggle(page, "Aspect ratio", aspectToggleRegex(options.aspectRatio), "aspect ratio");
        if (options.outputCount && options.outputCount > 1) {
          const count = Math.min(4, Math.max(1, Math.round(options.outputCount)));
          await selectToggle(page, "Output count", new RegExp(`^\\s*x${count}\\s*$`, "i"), "output count");
        }
      } else {
        await selectToggle(page, "Mode", /^\s*(?:videocam\s*)?video\s*$/i, "Video mode");
        if (options.referenceImagePaths.length > 0) {
          // Multiple image references are a Flow "Ingredients" workflow.  Do
          // not use Frames here: it has different first/last-frame semantics.
          await selectToggle(page, "Video type", /^\s*ingredients\s*$/i, "Ingredients reference mode");
        }
        await selectModel(page, options.model ?? "gemini-omni-flash");
        await selectToggle(page, "Aspect ratio", aspectToggleRegex(options.aspectRatio), "aspect ratio");
        await selectToggle(page, "Video duration", new RegExp(`^\\s*${escapeRegex(options.duration ?? "8s")}\\s*$`, "i"), "video duration");
      }
    } finally {
      // The open settings sheet covers the composer: the "Start generation"
      // click silently no-ops while it is up. Close it before submitting.
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(400);
    }
  }

  /**
   * Attaches caller-provided images through Flow's Ingredients drawer. This
   * is intentionally separate from the project-level Add media menu: assets
   * uploaded there are not automatically visual prompt references.
   */
  private async attachReferenceImages(
    page: Page,
    referenceImagePaths: string[],
    mode: FlowReferenceMode,
    options: BrowserGenerationOptions,
  ): Promise<void> {
    if (mode !== "ingredients") {
      throw new VideoSystemError("CONFIGURATION_ERROR", `Unsupported Flow reference mode: ${mode}.`);
    }
    await options.onProgress("reference_upload_started", { count: referenceImagePaths.length, mode });

    const drawerOpened = await page.evaluate(() => {
      const control = Array.from(document.querySelectorAll("button, [role=button]")).find(
        (element) => element.getAttribute("aria-label") === "Add ingredients to the prompt box",
      ) as HTMLElement | undefined;
      if (!control) return false;
      control.click();
      return true;
    });
    if (!drawerOpened) {
      throw new VideoSystemError("FLOW_UI_CHANGED", "Flow's Ingredients drawer was not available for the requested image references.", { retryable: true });
    }

    const uploadControl = await waitUntil(
      () => page.evaluate(() => {
        const control = Array.from(document.querySelectorAll("button, [role=button]")).find(
          (element) => element.getAttribute("aria-label") === "Upload media",
        ) as HTMLButtonElement | undefined;
        if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return false;
        const style = window.getComputedStyle(control);
        const bounds = control.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
      }),
      5_000,
      100,
    );
    if (!uploadControl) {
      throw new VideoSystemError("FLOW_UI_CHANGED", "Flow's Ingredients drawer did not expose its Upload media control.", { retryable: true });
    }

    const chooserPromise = page.waitForFileChooser({ timeout: 10_000 }).catch(() => undefined);
    const clickedUpload = await page.evaluate(() => {
      const control = Array.from(document.querySelectorAll("button, [role=button]")).find(
        (element) => element.getAttribute("aria-label") === "Upload media",
      ) as HTMLElement | undefined;
      if (!control) return false;
      control.click();
      return true;
    });
    const chooser = await chooserPromise;
    if (!clickedUpload || !chooser) {
      throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", "Flow did not open the Ingredients image chooser.", { retryable: true });
    }
    if (!chooser.isMultiple()) {
      throw new VideoSystemError("FLOW_UI_CHANGED", "Flow's current image chooser no longer accepts multiple reference images.", { retryable: true });
    }

    await chooser.accept(referenceImagePaths);
    // FileChooser.accept confirms that Chromium attached the explicit files to
    // Flow's upload control. Wait briefly for Flow to surface a server-side
    // error before allowing a paid generation to be submitted.
    const uploadFailure = await waitUntil(
      () => page.evaluate(() => {
        const visible = (element: Element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const bounds = html.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
        };
        return Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error" i], .error-message'))
          .filter(visible)
          .map((element) => ((element as HTMLElement).innerText ?? element.textContent ?? "").trim())
          .find((message) => /\b(?:upload|media|image).{0,80}\b(?:failed|error|unsupported|rejected)\b|\b(?:failed|error|unsupported|rejected)\b.{0,80}\b(?:upload|media|image)\b/i.test(message));
      }),
      1_500,
      150,
    );
    if (uploadFailure) {
      throw new VideoSystemError("SUBMISSION_FAILED", `Flow rejected a reference image upload: ${uploadFailure}`, { retryable: false });
    }
    await options.onProgress("reference_upload_completed", { count: referenceImagePaths.length, mode });
  }

  private async submit(page: Page, baseline: GenerationSnapshot, ackTimeoutMs = 20_000): Promise<void> {
    const clicked = await clickByAccessibleText(page, /\b(?:start generation|generate|create video|create image)\b/i);
    if (!clicked) {
      throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", "Could not find an enabled Flow generation control.", { retryable: true });
    }
    const acknowledged = await waitUntil(
      async () => {
        const current = await inspectGenerationSurface(page);
        return current.hasProgress || current.progressSignature !== baseline.progressSignature || current.downloadControls > baseline.downloadControls;
      },
      ackTimeoutMs,
      500,
    );
    if (!acknowledged) {
      throw new VideoSystemError("SUBMISSION_FAILED", "Flow did not show an observable generation acknowledgement after submission.", {
        retryable: true,
      });
    }
  }

  private async waitForGeneration(
    page: Page,
    reference: string,
    options: BrowserGenerationOptions,
  ): Promise<ProviderObservation> {
    const active = this.active.get(reference);
    if (!active) throw new VideoSystemError("INTERNAL_ERROR", "Missing active Flow generation reference.");

    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let lastSignature = "";
    let interval = this.config.initialPollMs;
    let recoveryAttempts = 0;

    while (Date.now() - startedAt < options.maxWaitMs) {
      if (await options.isCancelled()) {
        throw new VideoSystemError("CANCELLED", "Video job was cancelled before asset retrieval.");
      }
      const observation = await this.observe(page, active);
      if (observation.state === "FAILED") {
        throw new VideoSystemError("GENERATION_REJECTED", observation.message ?? "Flow reported that generation failed.", { retryable: true });
      }
      if (observation.state === "GENERATED") {
        await options.onProgress("generation_completed", { sourceAvailable: Boolean(observation.assetUrl) });
        return observation;
      }

      const signature = `${observation.state}:${observation.progressSignature ?? ""}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastProgressAt = Date.now();
        interval = this.config.initialPollMs;
        await options.onProgress("generation_progress", { providerState: observation.state });
      } else {
        interval = Math.min(this.config.maxPollMs, Math.round(interval * 1.5));
      }

      if (Date.now() - lastProgressAt > this.config.progressStallMs) {
        if (recoveryAttempts >= 1) {
          throw new VideoSystemError("GENERATION_TIMEOUT", "Flow generation stopped showing progress beyond the configured stall threshold.", {
            retryable: true,
          });
        }
        recoveryAttempts += 1;
        await options.onProgress("generation_stall_recovery", { attempt: recoveryAttempts });
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        lastProgressAt = Date.now();
        interval = this.config.initialPollMs;
      }
      await sleep(interval);
    }
    throw new VideoSystemError("GENERATION_TIMEOUT", "Flow generation exceeded the configured deadline.", { retryable: true });
  }

  private async observe(page: Page, active: ActiveGeneration): Promise<ProviderObservation> {
    const current = await inspectGenerationSurface(page);
    if (current.errorMessage) return { state: "FAILED", message: current.errorMessage };
    const newAssetUrl = current.videoSources.find((source) => !active.baseline.videoSources.includes(source));
    const newImageUrl = current.imageSources.find((source) => !active.baseline.imageSources.includes(source));
    const newlyAvailableDownload = current.downloadControls > active.baseline.downloadControls;
    if (newAssetUrl || newImageUrl || newlyAvailableDownload) {
      active.sourceUrl = newAssetUrl ?? newImageUrl;
      return {
        state: "GENERATED",
        assetUrl: newAssetUrl ?? newImageUrl,
        progressSignature: current.progressSignature,
      };
    }
    return {
      state: current.hasProgress ? "GENERATING" : "QUEUED",
      progressSignature: current.progressSignature,
    };
  }

  private async retrieveAsset(
    page: Page,
    reference: string,
    observation: ProviderObservation,
    directories: JobDirectories,
    options: BrowserGenerationOptions,
  ): Promise<AssetRetrievalResult> {
    // Flow reports completion as soon as the result tile appears, but the
    // playable/downloadable asset can lag several seconds behind while the
    // clip is still encoding. A single-shot retrieval here threw away paid
    // generations, so retrieval keeps retrying within a bounded deadline.
    const deadline = Date.now() + RETRIEVAL_DEADLINE_MS;
    let attempt = 0;
    while (true) {
      attempt += 1;
      if (await options.isCancelled()) {
        throw new VideoSystemError("CANCELLED", "Video job was cancelled during asset retrieval.");
      }
      // In current Flow, a generated batch may expose only a thumbnail until
      // its tile is opened. Opening that tile reveals a short-lived, authorized
      // flow-content.google video URL (or a googleusercontent image URL).
      // Prefer this exact generated asset over a generic batch download
      // because Ingredients also create downloadable uploaded-image batches
      // beneath the render.
      const isImage = options.kind === "image";
      const directVideoUrl = observation.assetUrl
        ?? (isImage ? await revealLatestGeneratedImageUrl(page) : await revealLatestGeneratedVideoUrl(page));
      if (directVideoUrl?.startsWith("https://")) {
        try {
          await options.onProgress(attempt === 1 ? "download_direct_fallback" : "download_direct_retry", { attempt });
          return {
            stagedPath: await this.assets.downloadToStaging(directVideoUrl, directories, isImage ? ".png" : ".mp4"),
            sourceUrl: directVideoUrl,
          };
        } catch {
          // Some Flow deployments require the browser's download gesture. Fall
          // through to the video-batch control rather than losing the clip.
          await options.onProgress("download_direct_fallback_failed", { attempt });
        }
      }

      const existing = new Set(await fs.readdir(directories.temporary));
      // A project keeps prior renders visible.  Flow labels every result's
      // control "Download batch", so choose the newest visible batch instead
      // of accidentally exporting an older clip.
      const clickedDownload = await clickLatestDownload(page);
      if (clickedDownload) {
        await options.onProgress("download_started", { attempt });
        const downloaded = await waitForBrowserDownload(
          directories.temporary,
          existing,
          Math.min(DOWNLOAD_WAIT_MS, Math.max(5_000, deadline - Date.now())),
          options.isCancelled,
        );
        if (downloaded) {
          const extension = path.extname(downloaded) || ".mp4";
          const stagedPath = path.join(directories.source, `flow-download-${Date.now()}${extension}`);
          await fs.rename(path.join(directories.temporary, downloaded), stagedPath);
          return { stagedPath, sourceUrl: observation.assetUrl };
        }
      }

      if (Date.now() >= deadline) break;
      const retryDelay = retrievalRetryDelayMs(attempt);
      await options.onProgress("download_retry_scheduled", { attempt, retryInMs: retryDelay });
      await sleep(retryDelay);
      // Opening the newest tile each round also covers the case where Flow
      // only exposes the encoded source after the tile has been open a while.
      const surfaced = options.kind === "image"
        ? await revealLatestGeneratedImageUrl(page)
        : await revealLatestGeneratedVideoUrl(page);
      if (surfaced?.startsWith("https://")) observation.assetUrl = surfaced;
    }

    if (observation.assetUrl?.startsWith("https://")) {
      await options.onProgress("download_direct_fallback");
      return { stagedPath: await this.assets.downloadToStaging(observation.assetUrl, directories), sourceUrl: observation.assetUrl };
    }
    throw new VideoSystemError(
      "DOWNLOAD_FAILED",
      `Flow completed but the clip never became downloadable within ${Math.round(RETRIEVAL_DEADLINE_MS / 1000)} s across ${attempt} retrieval attempt(s).`,
      { retryable: true },
    );
  }

  private async waitForPrompt(page: Page, timeoutMs: number) {
    const selectors = [
      // Flow currently uses a ProseMirror composer.  Do not select the
      // "Editable text" input: that is the project title, not the prompt.
      'div.ProseMirror[contenteditable="true"]',
      '[placeholder*="What do you want to create" i]',
      '[aria-label*="What do you want to create" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="describe" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[data-testid*="prompt"]',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    const found = await waitUntil(async () => {
      try {
        return await findFirstVisible(page, selectors);
      } catch {
        return undefined;
      }
    }, timeoutMs, 300);
    if (!found) {
      throw new VideoSystemError("SELECTOR_RESOLUTION_FAILED", "Flow prompt editor did not become available.", { retryable: true });
    }
    return found;
  }
}

/** Opens the newest generated video tile and returns its authorized media URL. */
export async function revealLatestGeneratedVideoUrl(page: Page): Promise<string | undefined> {
  const opened = await page.evaluate(() => {
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const bounds = html.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const tile = Array.from(document.querySelectorAll("flow-video-tile"))
      .filter(visible)
      .at(-1) as HTMLElement | undefined;
    if (!tile) return false;
    tile.click();
    return true;
  });
  if (!opened) return undefined;
  return waitUntil(
    () => page.evaluate(() => {
      const video = document.querySelector("video") as HTMLVideoElement | null;
      // currentSrc reflects the resource the element actually plays, including
      // blob/object URLs Flow swaps in after the clip finishes encoding.
      const source = video?.currentSrc || video?.src || "";
      return source.startsWith("https://") ? source : false;
    }),
    8_000,
    100,
  );
}

const MODEL_UI_LABELS: Record<FlowVideoModel, RegExp> = {
  // The account's current Flow UI labels this model "Omni 1.1 Flash".
  "gemini-omni-flash": /\b(?:gemini\s+)?omni(?:\s+1\.1)?\s+flash\b/i,
  "veo-3.1-fast": /\bveo\s*3\.1.*\bfast\b/i,
  "veo-3.1-quality": /\bveo\s*3\.1.*\b(?:quality|highest)\b/i,
};

async function openSettings(page: Page): Promise<void> {
  const opened = await page.evaluate(() => {
    const control = Array.from(document.querySelectorAll("button, [role=button]")).find(
      (element) => element.getAttribute("aria-label") === "Settings trigger",
    ) as HTMLElement | undefined;
    if (!control) return false;
    control.click();
    return true;
  });
  if (!opened) {
    throw new VideoSystemError("FLOW_UI_CHANGED", "Flow's generation settings control was not available.", { retryable: true });
  }
  const visible = await waitUntil(
    () => page.evaluate(() => Boolean(document.querySelector('[aria-label="Mode"]'))),
    5_000,
    100,
  );
  if (!visible) throw new VideoSystemError("FLOW_UI_CHANGED", "Flow did not open its generation settings panel.", { retryable: true });
}

async function selectToggle(page: Page, groupLabel: string, option: RegExp, setting: string): Promise<void> {
  const selected = await page.evaluate(({ groupLabel: requestedGroup, source, flags }) => {
    const expression = new RegExp(source, flags);
    const group = Array.from(document.querySelectorAll('[aria-label]')).find((element) => element.getAttribute("aria-label") === requestedGroup);
    if (!group) return false;
    const choices = Array.from(group.querySelectorAll('button, [role="radio"], [role="option"]')) as HTMLElement[];
    // Flow's Angular toggle controls prefix their visible label with a
    // Material icon (for example, "chrome_extension Ingredients"). Prefer
    // the semantic toggle-text child so the selector remains stable when
    // Flow changes icon names.
    const target = choices.find((element) => {
      const semanticLabel = element.querySelector(".toggle-text")?.textContent;
      const label = (semanticLabel || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return expression.test(label);
    });
    if (!target || target.getAttribute("aria-disabled") === "true" || (target as HTMLButtonElement).disabled) return false;
    target.click();
    return true;
  }, { groupLabel, source: option.source, flags: option.flags });
  if (!selected) {
    throw new VideoSystemError("FLOW_UI_CHANGED", `Flow does not currently expose the requested ${setting}.`, {
      retryable: true,
      details: { setting, groupLabel },
    });
  }
  await sleep(150);
}

async function selectModel(page: Page, model: FlowVideoModel): Promise<void> {
  const expected = MODEL_UI_LABELS[model];
  const alreadySelected = await page.evaluate(({ source, flags }) => {
    const button = document.querySelector('button[aria-label="Select model family"]') as HTMLElement | null;
    return button ? new RegExp(source, flags).test(button.innerText || button.textContent || "") : false;
  }, { source: expected.source, flags: expected.flags });
  if (alreadySelected) return;

  const opened = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Select model family"]') as HTMLElement | null;
    if (!button) return false;
    button.click();
    return true;
  });
  if (!opened) throw new VideoSystemError("FLOW_UI_CHANGED", "Flow's model selector was not available.", { retryable: true });
  const selected = await waitUntil(() => clickByAccessibleText(page, expected), 5_000, 150);
  if (!selected) {
    throw new VideoSystemError("FLOW_UI_CHANGED", `The requested Flow model (${model}) is not available to this account or in the current Flow UI.`, {
      retryable: true,
      details: { model },
    });
  }
  await sleep(200);
}

export async function clickLatestDownload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const controls = Array.from(document.querySelectorAll("button, [role=button], a[download]")) as HTMLElement[];
    const downloads = controls.filter((element) => {
      const label = `${element.getAttribute("aria-label") ?? ""} ${element.innerText ?? element.textContent ?? ""}`;
      return visible(element) && /\b(?:download|save)\b/i.test(label) && !(element as HTMLButtonElement).disabled;
    });
    // An Ingredients run leaves uploaded image batches beneath the generated
    // video.  Their Download batch controls are newer than the actual render,
    // so choosing the last generic control exports an input image instead of
    // the requested video.  Prefer the newest batch that contains a Flow video
    // tile, then fall back only for older Flow layouts without that marker.
    const videoDownloads = downloads.filter((control) => Boolean(
      control.closest(".batch-container")?.querySelector("flow-video-tile, [alt='Generated video thumbnail']"),
    ));
    const newest = videoDownloads.at(-1) ?? downloads.at(-1);
    if (!newest) return false;
    newest.click();
    return true;
  });
}

async function inspectGenerationSurface(page: Page): Promise<GenerationSnapshot> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      return style.visibility !== "hidden" && style.display !== "none" && html.getBoundingClientRect().width > 0;
    };
    const videoSources = Array.from(document.querySelectorAll("video[src], video source[src]"))
      .filter(visible)
      .map((element) => element.getAttribute("src") ?? "")
      .filter((source) => Boolean(source));
    const imageSources = Array.from(document.querySelectorAll("img[src^='https://']"))
      .filter(visible)
      .filter((element) => (element as HTMLImageElement).naturalWidth >= 256)
      .map((element) => (element as HTMLImageElement).src)
      .filter((source) => Boolean(source));
    const downloadControls = Array.from(document.querySelectorAll('button, [role="button"], a[download]')).filter((element) => {
      if (!visible(element)) return false;
      const text = `${element.getAttribute("aria-label") ?? ""} ${(element as HTMLElement).innerText ?? element.textContent ?? ""}`;
      return /\b(?:download|save)\b/i.test(text);
    }).length;
    const progress = Array.from(document.querySelectorAll('[role="progressbar"], [aria-label*="loading" i], [aria-label*="generating" i], [data-testid*="progress"], .loading'))
      .filter(visible)
      .map((element) => `${element.getAttribute("aria-label") ?? ""}:${(element as HTMLElement).innerText ?? element.textContent ?? ""}`.slice(0, 160))
      .join("|");
    const error = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"], .error-message'))
      .filter(visible)
      .map((element) => ((element as HTMLElement).innerText ?? element.textContent ?? "").trim())
      .find((text) => /\b(?:failed|error|rejected)\b/i.test(text));
    const mediaTiles = Array.from(document.querySelectorAll("flow-video-tile, flow-image-tile, flow-grid-tile-container"))
      .filter(visible)
      .length;
    return {
      videoSources,
      imageSources,
      downloadControls,
      // Image generations mount flow-image-tile elements with no progressbar
      // and a small placeholder — the tile count is the observable ack.
      progressSignature: `${progress}|videos:${videoSources.length}|images:${imageSources.length}|tiles:${mediaTiles}|downloads:${downloadControls}`,
      hasProgress: Boolean(progress),
      errorMessage: error?.slice(0, 300),
    };
  });
}

/**
 * Image renders expose their result as a large <img> rather than a video
 * element; the newest large https image on the surface is the fresh render.
 */
export async function revealLatestGeneratedImageUrl(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      const bounds = html.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll("img[src^='https://']"))
      .filter((element) => visible(element) && (element as HTMLImageElement).naturalWidth >= 256)
      .map((element) => (element as HTMLImageElement).src);
    return candidates.at(-1);
  });
}

async function waitUntil<T>(check: () => Promise<T | false | undefined>, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return undefined;
}

export async function waitForBrowserDownload(
  directory: string,
  initial: Set<string>,
  timeoutMs: number,
  isCancelled: () => Promise<boolean>,
): Promise<string | undefined> {
  const started = Date.now();
  const stableSizes = new Map<string, number>();
  while (Date.now() - started < timeoutMs) {
    if (await isCancelled()) throw new VideoSystemError("CANCELLED", "Video job was cancelled during download.");
    const entries = await fs.readdir(directory);
    for (const entry of entries) {
      if (initial.has(entry) || entry.endsWith(".crdownload") || entry.endsWith(".part")) continue;
      const fullPath = path.join(directory, entry);
      const stat = await fs.stat(fullPath).catch(() => undefined);
      if (!stat?.isFile() || stat.size < 4_096) continue;
      if (stableSizes.get(entry) === stat.size) return entry;
      stableSizes.set(entry, stat.size);
    }
    await sleep(750);
  }
  return undefined;
}

/** Aspect toggles may carry a Material icon prefix like "crop_16_9 16:9". */
function aspectToggleRegex(aspectRatio: string): RegExp {
  return new RegExp(`^\s*(?:crop_[a-z0-9_]+\s*)?${escapeRegex(aspectRatio)}\s*$`, "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Flow can lag between the completion tile and a downloadable asset. */
const RETRIEVAL_DEADLINE_MS = 180_000;
/** Fast-first backoff: the encoded asset usually appears within seconds. */
const RETRIEVAL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const RETRIEVAL_STEADY_RETRY_MS = 10_000;
const DOWNLOAD_WAIT_MS = 60_000;

function retrievalRetryDelayMs(attempt: number): number {
  return RETRIEVAL_RETRY_DELAYS_MS[Math.min(attempt - 1, RETRIEVAL_RETRY_DELAYS_MS.length - 1)] ?? RETRIEVAL_STEADY_RETRY_MS;
}
