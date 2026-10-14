import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectPageHtml, type ConnectPageInfo } from "../src/connect-page.js";

const info: ConnectPageInfo = {
  serverName: "Google Flow MCP",
  serverVersion: "2.0.0",
  mcpUrl: "http://127.0.0.1:4318/mcp",
  httpBaseUrl: "http://127.0.0.1:4318",
  transport: "both",
  workspaceRoot: "C:\\work\\google flow mcp",
  outputDir: "C:\\work\\google flow mcp\\outputs",
  watermarkRemoval: true,
  watermarkMethod: "auto",
  tokenRequired: true,
  tokenEnvVar: "FLOW_HTTP_TOKEN",
  tools: [
    { name: "generate_video", description: "Create a durable Google Flow video job." },
    { name: "get_video_job", description: "Get a durable video job." },
  ],
  stdioEntry: "C:\\work\\google flow mcp\\dist\\index.js",
};

test("connect page shows the MCP URL and both Codex connection paths", () => {
  const html = buildConnectPageHtml(info);
  assert.match(html, /http:\/\/127\.0\.0\.1:4318\/mcp/);
  assert.match(html, /\[mcp_servers\.google-flow\]/);
  // Snippets are HTML-escaped inside <code> blocks (quotes become &quot;).
  assert.match(html, /url = &quot;http:\/\/127\.0\.0\.1:4318\/mcp&quot;/);
  assert.match(html, /bearer_token_env_var = &quot;FLOW_HTTP_TOKEN&quot;/);
  // stdio path: node + the dist entry, TOML single-quoted so backslashes need no escaping
  assert.match(html, /command = &quot;node&quot;/);
  assert.match(html, /args = \[&#39;C:\\work\\google flow mcp\\dist\\index\.js&#39;\]/);
});

test("connect page documents the watermark shield and delivery locations", () => {
  const html = buildConnectPageHtml(info);
  assert.match(html, /SHIELD ON/);
  assert.match(html, /Watermark removed/);
  assert.match(html, /Delivered to IDE/);
  assert.match(html, /delivery\.localPath/);
  assert.match(html, /outputs/);
});

test("connect page lists tools and never embeds secret values", () => {
  const html = buildConnectPageHtml(info);
  assert.match(html, /generate_video/);
  assert.match(html, /get_video_job/);
  assert.doesNotMatch(html, /Bearer [A-Za-z0-9_-]{8,}/, "no token material may be rendered");
});

test("dynamic values are HTML-escaped", () => {
  const html = buildConnectPageHtml({ ...info, workspaceRoot: 'C:\\work\\<script>alert(1)</script>' });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw angle brackets from config must not reach the page");
  assert.match(html, /&lt;script&gt;/);
});

test("a disabled watermark shield is shown as off", () => {
  const html = buildConnectPageHtml({ ...info, watermarkRemoval: false });
  assert.match(html, /SHIELD OFF/);
});
