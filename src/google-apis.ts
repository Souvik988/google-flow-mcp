import fs from "fs/promises";
import path from "path";
import { BridgeClient } from "./bridge-client.js";
import { downloadFile, getMimeType } from "./utils.js";
import { assertPathInside } from "./video/config.js";
import { VideoSystemError } from "./video/errors.js";

// The Apps Script contract is dynamically shaped. Video orchestration itself is
// strongly typed; these legacy Workspace response payloads remain opaque.
type LegacyBridgeData = any;

function safeBaseName(name: string, fallback: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
}

/** Workspace APIs routed through the authenticated Apps Script bridge. */
export class GoogleAPIs {
  private client?: BridgeClient;

  private get bridge(): BridgeClient {
    if (!this.client) this.client = new BridgeClient();
    return this.client;
  }

  async searchEmails(query: string, maxResults = 10): Promise<LegacyBridgeData[]> {
    const result = await this.bridge.post<{ results?: unknown[] }>("gmailSearch", { query, maxResults });
    return result.results ?? [];
  }

  async readEmail(messageId: string): Promise<LegacyBridgeData> {
    return this.bridge.post("gmailRead", { messageId });
  }

  async sendEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<LegacyBridgeData> {
    return this.bridge.post("gmailSend", { to, subject, body, cc, bcc });
  }

  async replyToEmail(messageId: string, body: string): Promise<LegacyBridgeData> {
    return this.bridge.post("gmailReply", { messageId, body });
  }

  async listDriveFiles(folderId?: string, query?: string, fileType?: string): Promise<LegacyBridgeData[]> {
    const result = await this.bridge.post<{ files?: unknown[] }>("driveList", { folderId, query, fileType });
    return result.files ?? [];
  }

  async createDriveFolder(name: string, parentId?: string): Promise<LegacyBridgeData> {
    return this.bridge.post("driveCreateFolder", { name, parentId });
  }

  async trashDriveFile(fileId: string): Promise<LegacyBridgeData> {
    return this.bridge.post("driveTrash", { fileId });
  }

  async getDriveDownloadUrl(fileId: string): Promise<LegacyBridgeData> {
    return this.bridge.post("driveGetDownloadUrl", { fileId });
  }

  async uploadFile(localPath: string, parentId?: string, name?: string): Promise<LegacyBridgeData> {
    const target = assertPathInside(process.cwd(), path.resolve(process.cwd(), localPath));
    const buffer = await fs.readFile(target);
    if (buffer.byteLength > 25 * 1024 * 1024) {
      throw new VideoSystemError("PATH_VALIDATION_FAILED", "Bridge upload is limited to 25 MB; use Drive's native upload flow for larger files.");
    }
    return this.bridge.post("driveUpload", {
      name: safeBaseName(name || path.basename(target), "upload.bin"),
      contentBase64: buffer.toString("base64"),
      mimeType: getMimeType(target),
      parentId,
    });
  }

  async downloadFile(fileId: string, localPath: string): Promise<string> {
    const root = process.cwd();
    const requested = assertPathInside(root, path.resolve(root, localPath));
    const result = await this.bridge.post<{ name?: string; contentBase64?: string; downloadUrl?: string }>("driveDownload", { fileId });
    const stat = await fs.stat(requested).catch(() => undefined);
    const target = stat?.isDirectory()
      ? assertPathInside(root, path.join(requested, safeBaseName(result.name || `file_${fileId}`, "download.bin")))
      : requested;
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (result.contentBase64) {
      const temporary = `${target}.${process.pid}.part`;
      await fs.writeFile(temporary, Buffer.from(result.contentBase64, "base64"));
      await fs.rename(temporary, target);
      return target;
    }
    if (result.downloadUrl) {
      return downloadFile(result.downloadUrl, target, { allowedHosts: ["google.com", "googleusercontent.com", "googlevideo.com"] });
    }
    throw new VideoSystemError("DOWNLOAD_FAILED", "Bridge returned neither file data nor a download URL.");
  }

  async readSheet(spreadsheetId: string, range: string): Promise<LegacyBridgeData> {
    return this.bridge.post("sheetsRead", { spreadsheetId, range });
  }

  async writeSheet(spreadsheetId: string, range: string, values: unknown[][]): Promise<LegacyBridgeData> {
    return this.bridge.post("sheetsWrite", { spreadsheetId, range, values });
  }

  async appendSheet(spreadsheetId: string, range: string, values: unknown[][]): Promise<LegacyBridgeData> {
    return this.bridge.post("sheetsAppend", { spreadsheetId, range, values });
  }

  async createSpreadsheet(title: string, sheetNames?: string[]): Promise<LegacyBridgeData> {
    return this.bridge.post("sheetsCreate", { title, sheetNames });
  }

  async createDoc(title: string, content?: string): Promise<LegacyBridgeData> {
    return this.bridge.post("docsCreate", { title, content });
  }

  async readDoc(documentId: string): Promise<LegacyBridgeData> {
    return this.bridge.post("docsRead", { documentId });
  }

  async appendToDoc(documentId: string, content: string): Promise<LegacyBridgeData> {
    return this.bridge.post("docsAppend", { documentId, content });
  }

  async listCalendarEvents(calendarId = "primary", timeMin?: string, timeMax?: string, maxResults = 10): Promise<LegacyBridgeData[]> {
    const result = await this.bridge.post<{ events?: unknown[] }>("calendarList", { calendarId, timeMin, timeMax, maxResults });
    return result.events ?? [];
  }

  async createCalendarEvent(
    summary: string,
    description: string | undefined,
    startTime: string,
    endTime: string,
    attendees?: string[],
    location?: string,
    timeZone?: string,
  ): Promise<LegacyBridgeData> {
    return this.bridge.post("calendarCreate", { summary, description, startTime, endTime, attendees, location, timeZone });
  }

  async updateCalendarEvent(eventId: string, updates: Record<string, string | undefined>): Promise<LegacyBridgeData> {
    return this.bridge.post("calendarUpdate", { eventId, ...updates });
  }

  async deleteCalendarEvent(eventId: string): Promise<LegacyBridgeData> {
    return this.bridge.post("calendarDelete", { eventId });
  }
}
