import fs from "fs/promises";
import path from "path";
import { VideoSystemError } from "./errors.js";

/** Flow's Ingredients composer is intended for a small, deliberate set of visual references. */
export const MAX_FLOW_REFERENCE_IMAGES = 5;
export const MAX_FLOW_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;

const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function isRecognizedImageSignature(bytes: Buffer): boolean {
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return isJpeg || isPng || isWebp;
}

/**
 * Resolves and validates an explicit user-provided local image before the
 * browser is permitted to upload it to Google Flow.  Paths are never inferred
 * or scanned; callers must provide every image path intentionally.
 */
export async function validateReferenceImagePaths(paths: readonly string[] | undefined): Promise<string[]> {
  if (!paths?.length) return [];
  if (paths.length > MAX_FLOW_REFERENCE_IMAGES) {
    throw new VideoSystemError(
      "PATH_VALIDATION_FAILED",
      `Google Flow Ingredients accepts at most ${MAX_FLOW_REFERENCE_IMAGES} reference images per job.`,
    );
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const requestedPath of paths) {
    if (!path.isAbsolute(requestedPath)) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", "Each referenceImagePaths entry must be an absolute local file path.");
    }
    const extension = path.extname(requestedPath).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", "Reference images must be PNG, JPEG, or WebP files.");
    }

    let canonicalPath: string;
    let stat;
    try {
      canonicalPath = await fs.realpath(requestedPath);
      stat = await fs.stat(canonicalPath);
    } catch {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", `Reference image was not found or could not be read: ${path.basename(requestedPath)}.`);
    }
    if (!stat.isFile()) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", `Reference image is not a regular file: ${path.basename(requestedPath)}.`);
    }
    if (stat.size <= 0 || stat.size > MAX_FLOW_REFERENCE_IMAGE_BYTES) {
      throw new VideoSystemError(
        "PATH_VALIDATION_FAILED",
        `Reference image ${path.basename(requestedPath)} must be between 1 byte and ${MAX_FLOW_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB.`,
      );
    }
    const file = await fs.open(canonicalPath, "r");
    const header = Buffer.alloc(16);
    try {
      await file.read(header, 0, header.length, 0);
    } finally {
      await file.close();
    }
    if (!isRecognizedImageSignature(header)) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", `Reference image does not contain a recognized PNG, JPEG, or WebP image: ${path.basename(requestedPath)}.`);
    }
    const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(canonicalPath);
    }
  }
  return resolved;
}
