import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { sanitizeErrorMessage } from "./video/errors.js";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const configuredLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase();
const sensitiveKey = /(?:pass(?:word|wd)?|secret|token|authorization|cookie|email|otp|credential|api[-_]?key)/i;

function shouldLog(level: LogLevel): boolean {
  const current = LogLevel[configuredLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
  return level >= current;
}

function redact(value: unknown, key?: string, depth = 0): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeErrorMessage(value).replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL_REDACTED]");
  if (Array.isArray(value)) return depth > 5 ? "[TRUNCATED]" : value.map((item) => redact(item, undefined, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 5) return "[TRUNCATED]";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, depth + 1)]));
  }
  return value;
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  if (!shouldLog(level)) return;
  const suffix = data === undefined ? "" : ` | ${JSON.stringify(redact(data))}`;
  console.error(`[${new Date().toISOString()}] [${LogLevel[level]}] ${sanitizeErrorMessage(message)}${suffix}`);
}

export const logger = {
  debug: (message: string, data?: unknown) => log(LogLevel.DEBUG, message, data),
  info: (message: string, data?: unknown) => log(LogLevel.INFO, message, data),
  warn: (message: string, data?: unknown) => log(LogLevel.WARN, message, data),
  error: (message: string, data?: unknown) => log(LogLevel.ERROR, message, data),
};

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
  onRetry?: (error: Error, attempt: number) => void;
}

/** Bounded retry for explicitly safe operations. Callers must not use it for an uncertain side effect. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 10_000, shouldRetry = () => true, onRetry } = options;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= maxAttempts || !shouldRetry(lastError, attempt)) break;
      const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(capped * (0.75 + Math.random() * 0.25));
      logger.warn("Safe operation failed; retrying", { attempt, maxAttempts, error: lastError.message, delayMs: delay });
      onRetry?.(lastError, attempt);
      await sleep(delay);
    }
  }
  throw lastError ?? new Error("Retry operation failed without an error.");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".txt": "text/plain", ".csv": "text/csv",
  ".html": "text/html", ".json": "application/json", ".xml": "application/xml", ".zip": "application/zip",
  ".gz": "application/gzip", ".tar": "application/x-tar",
};

export function getMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export interface DownloadFileOptions {
  timeoutMs?: number;
  maxBytes?: number;
  allowedHosts?: string[];
}

function isAllowedDownloadHost(hostname: string, allowedHosts?: string[]): boolean {
  return Boolean(allowedHosts?.some((host) => hostname === host || hostname.endsWith(`.${host}`)));
}

/**
 * Follows only a small number of HTTPS redirects and validates every hop. This
 * prevents an approved Google download URL from redirecting a server-side fetch
 * to an internal or otherwise untrusted host.
 */
export async function fetchAllowedDownload(url: URL, options: DownloadFileOptions): Promise<Response> {
  const maxRedirects = 5;
  let current = url;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (current.protocol !== "https:") throw new Error("Only HTTPS download URLs are allowed.");
    if (options.allowedHosts && !isAllowedDownloadHost(current.hostname, options.allowedHosts)) {
      throw new Error("Download URL host is not allowed.");
    }
    const response = await fetch(current, {
      headers: { "User-Agent": "Google-Flow-MCP/2.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Download redirect did not include a location.");
    current = new URL(location, current);
  }
  throw new Error("Download exceeded the redirect limit.");
}

function byteLimit(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error("Download exceeds configured size limit."));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Streams to a temporary file and atomically exposes the completed destination. */
export async function downloadFile(url: string, destinationPath: string, options: DownloadFileOptions = {}): Promise<string> {
  const parsed = new URL(url);
  const response = await fetchAllowedDownload(parsed, options);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} while downloading asset.`);
  const declaredLength = Number(response.headers.get("content-length") || "0");
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  if (declaredLength && declaredLength > maxBytes) throw new Error("Download exceeds configured size limit.");
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporary = `${destinationPath}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as never), byteLimit(maxBytes), createWriteStream(temporary, { flags: "wx" }));
    const stat = await fs.stat(temporary);
    if (!stat.size || stat.size > maxBytes) throw new Error("Downloaded asset has an invalid size.");
    await fs.rename(temporary, destinationPath);
    return destinationPath;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function safeJsonParse<T = unknown>(input: string, fallback?: T): T | undefined {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function extractDriveFileId(input: string): string {
  if (/^[-\w]{25,50}$/.test(input)) return input;
  for (const pattern of [/\/file\/d\/([-\w]{25,})/, /\/d\/([-\w]{25,})/, /id=([-\w]{25,})/, /\/folders\/([-\w]{25,})/]) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return input;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Number((bytes / 1024 ** index).toFixed(2))} ${sizes[index]}`;
}
