import fs from "fs/promises";
import path from "path";
import { assertPathInside } from "./config.js";
import { VideoSystemError } from "./errors.js";
import { downloadFile } from "../utils.js";

export interface JobDirectories {
  root: string;
  request: string;
  source: string;
  processed: string;
  quality: string;
  final: string;
  temporary: string;
}

export function safeFileName(name: string, fallback = "generated-video.mp4"): string {
  const normalized = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  const withoutLeadingDots = normalized.replace(/^\.+/, "");
  return withoutLeadingDots || fallback;
}

export class AssetManager {
  constructor(private readonly outputRoot: string) {}

  async createJobDirectories(jobId: string): Promise<JobDirectories> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", "Invalid job identifier for asset storage.");
    }
    const root = assertPathInside(this.outputRoot, path.join(this.outputRoot, jobId));
    const directories: JobDirectories = {
      root,
      request: path.join(root, "request"),
      source: path.join(root, "source"),
      processed: path.join(root, "processed"),
      quality: path.join(root, "qc"),
      final: path.join(root, "final"),
      temporary: path.join(root, "tmp"),
    };
    await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })));
    return directories;
  }

  async writeRequestArtifact(root: string, name: string, data: unknown): Promise<string> {
    const safeName = safeFileName(name, "request.json");
    const target = assertPathInside(root, path.join(root, "request", safeName));
    await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
    return target;
  }

  async writeTextArtifact(root: string, name: string, text: string): Promise<string> {
    const safeName = safeFileName(name, "prompt.txt");
    const target = assertPathInside(root, path.join(root, "request", safeName));
    await fs.writeFile(target, text, "utf8");
    return target;
  }

  async writeQualityArtifact(root: string, name: string, data: unknown): Promise<string> {
    const safeName = safeFileName(name, "quality-report.json");
    const target = assertPathInside(root, path.join(root, "qc", safeName));
    await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
    return target;
  }

  async downloadToStaging(sourceUrl: string, directory: JobDirectories, extension = ".mp4"): Promise<string> {
    const url = new URL(sourceUrl);
    if (!isAllowedGoogleAssetHost(url.hostname)) {
      throw new VideoSystemError("DOWNLOAD_FAILED", "Refusing to download an asset from an untrusted host.");
    }
    const safeExtension = /^\.(mp4|png|jpg|jpeg|webm|webp)$/i.test(extension) ? extension.toLowerCase() : ".mp4";
    const target = path.join(directory.source, `provider-download-${Date.now()}${safeExtension}`);
    try {
      return await downloadFile(sourceUrl, target, {
        allowedHosts: ["google.com", "googleusercontent.com", "googlevideo.com", "flow-content.google"],
        maxBytes: 2 * 1024 * 1024 * 1024,
      });
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      throw new VideoSystemError("DOWNLOAD_FAILED", "Could not save the retrieved asset.", { retryable: true, cause: error });
    }
  }

  async finalize(stagedPath: string, directory: JobDirectories, filename = "video.mp4"): Promise<string> {
    const source = assertPathInside(directory.root, stagedPath);
    const extension = path.extname(source) || ".mp4";
    const destinationName = safeFileName(filename, `video${extension}`);
    const destination = assertPathInside(directory.root, path.join(directory.final, destinationName));
    await fs.rename(source, destination);
    return destination;
  }

  async cleanTemporary(directory: JobDirectories): Promise<void> {
    const entries = await fs.readdir(directory.temporary).catch(() => [] as string[]);
    await Promise.all(entries.map((entry) => fs.rm(path.join(directory.temporary, entry), { force: true, recursive: true })));
  }
}

export function isAllowedGoogleAssetHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "google.com" ||
    normalized.endsWith(".google.com") ||
    normalized.endsWith(".googleusercontent.com") ||
    normalized.endsWith(".googlevideo.com") ||
    // Flow's result-tile player serves finished clips from Google's own
    // .google brand gTLD (registry-restricted to Google), e.g.
    // flow-content.google/video/<id>?Expires=... — observed live 2026-09.
    normalized === "flow-content.google" ||
    normalized.endsWith(".flow-content.google")
  );
}
