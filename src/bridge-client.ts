import crypto from "crypto";
import { logger, withRetry } from "./utils.js";
import { VideoSystemError } from "./video/errors.js";

interface BridgeAuth {
  timestamp: string;
  nonce: string;
  signature: string;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** Authenticated client for the Apps Script bridge. Side-effecting POSTs are never blindly retried. */
export class BridgeClient {
  private readonly url: URL;
  private readonly secret: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const rawUrl = environment.FLOW_BRIDGE_URL;
    const secret = environment.FLOW_BRIDGE_TOKEN;
    if (!rawUrl) throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_BRIDGE_URL is not configured.");
    if (!secret) throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_BRIDGE_TOKEN is required for authenticated bridge calls.");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !(url.hostname === "script.google.com" || url.hostname.endsWith(".google.com"))) {
      throw new VideoSystemError("CONFIGURATION_ERROR", "FLOW_BRIDGE_URL must be an HTTPS Google Apps Script URL.");
    }
    this.url = url;
    this.secret = secret;
  }

  async post<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const auth = this.createAuth(action, payload);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload, auth }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new VideoSystemError("INTERNAL_ERROR", "Bridge request could not be completed. The operation outcome is unknown; it was not automatically retried.", {
        cause: error,
      });
    }
    return this.parseResponse<T>(response, action);
  }

  async get<T>(action: string, parameters: Record<string, string> = {}): Promise<T> {
    return withRetry(
      async () => {
        const auth = this.createAuth(action, parameters);
        const url = new URL(this.url);
        url.searchParams.set("action", action);
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
        url.searchParams.set("authTimestamp", auth.timestamp);
        url.searchParams.set("authNonce", auth.nonce);
        url.searchParams.set("authSignature", auth.signature);
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        return this.parseResponse<T>(response, action);
      },
      {
        maxAttempts: 3,
        shouldRetry: (error) => error instanceof VideoSystemError && error.retryable,
      },
    );
  }

  private createAuth(action: string, payload: Record<string, unknown>): BridgeAuth {
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const material = `${timestamp}\n${nonce}\n${action}\n${stableStringify(payload)}`;
    return {
      timestamp,
      nonce,
      signature: crypto.createHmac("sha256", this.secret).update(material).digest("base64url"),
    };
  }

  private async parseResponse<T>(response: Response, action: string): Promise<T> {
    if (!response.ok) {
      throw new VideoSystemError("INTERNAL_ERROR", `Bridge action ${action} returned HTTP ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch (error) {
      throw new VideoSystemError("INTERNAL_ERROR", `Bridge action ${action} returned invalid JSON.`, { cause: error, retryable: true });
    }
    if (result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error) {
      throw new VideoSystemError("INTERNAL_ERROR", `Bridge action ${action} was rejected.`, { retryable: false });
    }
    logger.debug("Authenticated bridge call completed", { action });
    return result as T;
  }
}
