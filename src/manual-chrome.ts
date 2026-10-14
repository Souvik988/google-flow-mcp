import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import { VideoSystemError } from "./video/errors.js";
import type { VideoSystemConfig } from "./video/config.js";

async function cdpIsReady(browserUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", browserUrl), { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveChromeExecutable(config: VideoSystemConfig): Promise<string> {
  const candidates = [
    config.browserExecutablePath,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next standard Chrome location.
    }
  }
  throw new VideoSystemError("CONFIGURATION_ERROR", "Google Chrome was not found. Set FLOW_BROWSER_EXECUTABLE_PATH to your chrome.exe path.");
}

/**
 * Starts an ordinary, visible Chrome process with a loopback-only DevTools
 * endpoint. The user completes Google sign-in directly in this browser; the
 * asset engine connects only after that and never handles credentials.
 */
export async function openManualChrome(config: VideoSystemConfig): Promise<{ alreadyRunning: boolean }> {
  if (!config.browserCdpUrl) {
    throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_BROWSER_CDP_URL is required for manual Chrome sign-in mode.");
  }
  const cdpUrl = new URL(config.browserCdpUrl);
  if (await cdpIsReady(cdpUrl.href)) return { alreadyRunning: true };

  await fs.mkdir(config.browserProfileDir, { recursive: true });
  const executable = await resolveChromeExecutable(config);
  const port = cdpUrl.port || "80";
  const child = spawn(executable, [
    `--remote-debugging-address=${cdpUrl.hostname === "localhost" ? "127.0.0.1" : cdpUrl.hostname}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    config.flowStudioUrl,
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await cdpIsReady(cdpUrl.href)) return { alreadyRunning: false };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new VideoSystemError("BROWSER_DISCONNECTED", "Normal Chrome was started but its local control endpoint did not become available. Close only the Flow Asset Studio Chrome window and try again.", { retryable: true });
}

/**
 * Opens the SAME Chrome profile in a completely clean Chrome process — no
 * remote-debugging endpoint, no automation flags. Google refuses fresh
 * sign-ins inside any DevTools-enabled browser ("This browser or app may not
 * be secure"), so manual (re-)authentication must happen here. The caller
 * waits for the window to close, then reconnects automation to the profile.
 */
export async function openCleanSignInChrome(config: VideoSystemConfig): Promise<{ child: ChildProcess }> {
  await fs.mkdir(config.browserProfileDir, { recursive: true });
  const executable = await resolveChromeExecutable(config);
  const child = spawn(executable, [
    `--user-data-dir=${config.browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://accounts.google.com/signin",
  ], { stdio: "ignore", windowsHide: false });
  return { child };
}

/** Resolves when the sign-in window is closed (or after the cap elapses). */
export function waitForSignInWindowClose(child: ChildProcess, timeoutMs = 15 * 60_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
