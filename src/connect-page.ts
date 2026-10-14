/**
 * The /connect page: a self-contained neubrutalism setup sheet that shows how
 * to point Codex (or any MCP client) at this server. Rendered server-side
 * from local configuration; no secrets are ever embedded in the page.
 */

export interface ConnectPageInfo {
  serverName: string;
  serverVersion: string;
  /** Absolute streamable-HTTP MCP endpoint, e.g. http://127.0.0.1:4318/mcp */
  mcpUrl: string;
  httpBaseUrl: string;
  transport: "stdio" | "http" | "both";
  workspaceRoot: string;
  outputDir: string;
  watermarkRemoval: boolean;
  watermarkMethod: "auto" | "unblend" | "inpaint" | "ffmpeg";
  tokenRequired: boolean;
  tokenEnvVar: string;
  tools: Array<{ name: string; description: string }>;
  /** Absolute path of the built stdio entry, e.g. <workspace>/dist/index.js */
  stdioEntry: string;
}

const WATERMARK_METHOD_LABELS: Record<ConnectPageInfo["watermarkMethod"], string> = {
  auto: "AUTO · Alpha-unblend → OpenCV inpaint → FFmpeg delogo",
  unblend: "UNBLEND · registered alpha reconstruction (best)",
  inpaint: "INPAINT ONLY · OpenCV Navier-Stokes",
  ffmpeg: "FFMPEG ONLY · delogo patch",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function codexStdioSnippet(info: ConnectPageInfo): string {
  return [
    "# ~/.codex/config.toml",
    "[mcp_servers.google-flow]",
    'command = "node"',
    `args = ['${info.stdioEntry}']`,
    "",
    "# Optional server settings passed to the process:",
    "# env = { FLOW_WATERMARK_REMOVAL = \"true\", FLOW_TRANSPORT = \"stdio\" }",
  ].join("\n");
}

function codexHttpSnippet(info: ConnectPageInfo): string {
  const lines = [
    "# ~/.codex/config.toml",
    "[mcp_servers.google-flow]",
    `url = "${info.mcpUrl}"`,
  ];
  if (info.tokenRequired) {
    lines.push(`bearer_token_env_var = "${info.tokenEnvVar}"`);
  }
  return lines.join("\n");
}

function desktopJsonSnippet(info: ConnectPageInfo): string {
  return JSON.stringify(
    {
      mcpServers: {
        "google-flow": {
          command: "node",
          args: [info.stdioEntry],
        },
      },
    },
    null,
    2,
  );
}

function copyButton(id: string, label = "COPY"): string {
  return `<button class="copy" type="button" data-copy="${id}">${label}</button>`;
}

export function buildConnectPageHtml(info: ConnectPageInfo): string {
  const name = escapeHtml(info.serverName);
  const version = escapeHtml(info.serverVersion);
  const mcpUrl = escapeHtml(info.mcpUrl);
  const httpBaseUrl = escapeHtml(info.httpBaseUrl);
  const outputDir = escapeHtml(info.outputDir);
  const workspaceRoot = escapeHtml(info.workspaceRoot);
  const tokenEnvVar = escapeHtml(info.tokenEnvVar);

  const watermarkStatus = info.watermarkRemoval
    ? `<span class="pill pill-green">SHIELD ON</span><span class="pill pill-purple">${escapeHtml(WATERMARK_METHOD_LABELS[info.watermarkMethod])}</span>`
    : `<span class="pill pill-red">SHIELD OFF</span><span class="pill">set FLOW_WATERMARK_REMOVAL=true</span>`;

  const toolCards = info.tools
    .map(
      (tool) =>
        `<div class="tool" title="${escapeHtml(tool.description)}"><span class="tool-name">${escapeHtml(tool.name)}</span><span class="tool-desc">${escapeHtml(
          tool.description.length > 110 ? `${tool.description.slice(0, 107)}…` : tool.description,
        )}</span></div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>${name} — Connect</title>
<style>
  :root {
    --ink: #101010;
    --paper: #f2eddf;
    --yellow: #ffd43b;
    --pink: #ff8fd6;
    --cyan: #74e6e2;
    --green: #8be28b;
    --purple: #c5a3ff;
    --red: #ff7a7a;
    --shadow: 8px 8px 0 var(--ink);
    --shadow-sm: 4px 4px 0 var(--ink);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Arial Black", "Segoe UI", system-ui, sans-serif;
    background: var(--paper);
    background-image: radial-gradient(#d8d2bf 1.2px, transparent 1.2px);
    background-size: 26px 26px;
    color: var(--ink);
    line-height: 1.45;
  }
  code, pre, .mono { font-family: "Cascadia Code", Consolas, "JetBrains Mono", monospace; }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 40px 22px 80px; }
  header { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 18px; margin-bottom: 34px; }
  h1 {
    font-size: clamp(2.1rem, 6vw, 3.6rem);
    letter-spacing: -1px;
    text-transform: uppercase;
    margin: 0;
    background: var(--yellow);
    border: 3px solid var(--ink);
    box-shadow: var(--shadow);
    padding: 10px 22px;
    transform: rotate(-1deg);
  }
  .sticker {
    display: inline-block;
    background: var(--pink);
    border: 3px solid var(--ink);
    box-shadow: var(--shadow-sm);
    padding: 6px 14px;
    font-weight: 900;
    text-transform: uppercase;
    transform: rotate(2deg);
    font-size: .95rem;
  }
  .statusbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 26px 0 34px; }
  .pill {
    display: inline-block;
    border: 3px solid var(--ink);
    background: #fff;
    box-shadow: var(--shadow-sm);
    padding: 5px 12px;
    font-weight: 900;
    font-size: .8rem;
    text-transform: uppercase;
  }
  .pill-green { background: var(--green); }
  .pill-purple { background: var(--purple); }
  .pill-cyan { background: var(--cyan); }
  .pill-yellow { background: var(--yellow); }
  .pill-red { background: var(--red); }
  section {
    background: #fff;
    border: 3px solid var(--ink);
    box-shadow: var(--shadow);
    padding: 26px 26px 30px;
    margin-bottom: 40px;
  }
  section.accent-yellow { background: var(--yellow); }
  section.accent-cyan { background: var(--cyan); }
  section.accent-pink { background: var(--pink); }
  h2 {
    margin: 0 0 6px;
    font-size: 1.45rem;
    text-transform: uppercase;
    letter-spacing: -.5px;
  }
  .sub { margin: 0 0 18px; font-family: Consolas, monospace; font-size: .85rem; }
  .bigurl {
    display: block;
    width: 100%;
    border: 3px solid var(--ink);
    background: var(--paper);
    box-shadow: var(--shadow-sm);
    padding: 14px 16px;
    font-family: Consolas, monospace;
    font-weight: 700;
    font-size: 1.05rem;
    margin: 0 0 18px;
    word-break: break-all;
  }
  pre.snippet {
    position: relative;
    border: 3px solid var(--ink);
    background: var(--paper);
    box-shadow: var(--shadow-sm);
    padding: 16px 16px 16px;
    margin: 0 0 18px;
    overflow-x: auto;
    font-size: .86rem;
    line-height: 1.55;
  }
  .copy {
    position: absolute;
    top: 10px;
    right: 10px;
    border: 3px solid var(--ink);
    background: var(--yellow);
    box-shadow: 3px 3px 0 var(--ink);
    padding: 4px 10px;
    font-family: inherit;
    font-weight: 900;
    font-size: .7rem;
    text-transform: uppercase;
    cursor: pointer;
  }
  .copy:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
  .copy.done { background: var(--green); }
  table { width: 100%; border-collapse: collapse; border: 3px solid var(--ink); background: #fff; }
  th, td { border: 2px solid var(--ink); padding: 8px 10px; text-align: left; font-size: .82rem; vertical-align: top; }
  th { background: var(--cyan); text-transform: uppercase; font-size: .75rem; }
  td code { font-weight: 700; }
  .tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  .tool {
    border: 3px solid var(--ink);
    background: #fff;
    box-shadow: var(--shadow-sm);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tool:hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 var(--ink); }
  .tool-name { font-weight: 900; font-size: .82rem; font-family: Consolas, monospace; }
  .tool-desc { font-size: .72rem; font-family: Consolas, monospace; color: #333; }
  .flow { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; margin: 12px 0 4px; }
  .flow-step {
    border: 3px solid var(--ink);
    box-shadow: var(--shadow-sm);
    padding: 10px 14px;
    font-weight: 900;
    font-size: .78rem;
    text-transform: uppercase;
    display: flex;
    align-items: center;
  }
  .flow-step:nth-child(1) { background: var(--cyan); }
  .flow-step:nth-child(2) { background: var(--yellow); }
  .flow-step:nth-child(3) { background: var(--pink); }
  .flow-step:nth-child(4) { background: var(--green); }
  .flow-arrow { align-self: center; font-weight: 900; font-size: 1.2rem; }
  .note { font-family: Consolas, monospace; font-size: .78rem; margin: 10px 0 0; }
  footer { text-align: center; font-family: Consolas, monospace; font-size: .75rem; margin-top: 50px; }
  a { color: var(--ink); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${name}</h1>
    <span class="sticker">Connect · v${version}</span>
  </header>

  <div class="statusbar">
    <span class="pill pill-cyan">transport: ${escapeHtml(info.transport)}</span>
    <span class="pill pill-yellow">workspace: ${workspaceRoot}</span>
    <span class="pill">outputs: ${outputDir}</span>
    ${watermarkStatus}
  </div>

  <section class="accent-yellow">
    <h2>① Connect Codex via server URL</h2>
    <p class="sub">Streamable-HTTP MCP endpoint, live on this machine while the server runs with FLOW_TRANSPORT=http or both.</p>
    <code class="bigurl" id="mcp-url">${mcpUrl}</code>
    <pre class="snippet" id="snip-http"><code>${escapeHtml(codexHttpSnippet(info))}</code>${copyButton("snip-http")}</pre>
    <p class="note">${info.tokenRequired
      ? `The API is token-protected: put your FLOW_HTTP_TOKEN value in the <b>${tokenEnvVar}</b> environment variable Codex reads, and never paste the token itself into the config file.`
      : "No token is configured; the endpoint accepts loopback connections without a bearer token."}</p>
  </section>

  <section>
    <h2>② Connect Codex via stdio</h2>
    <p class="sub">Zero-token option: Codex launches the server itself. Run <b>npm run build</b> once so the dist entry exists.</p>
    <pre class="snippet" id="snip-stdio"><code>${escapeHtml(codexStdioSnippet(info))}</code>${copyButton("snip-stdio")}</pre>
    <p class="note">If <b>node</b> is not on Codex's PATH, replace it with the absolute node.exe path. Restart Codex after editing config.toml, then run <b>codex mcp list</b> to confirm it says "ready".</p>
  </section>

  <section class="accent-cyan">
    <h2>③ Other MCP clients</h2>
    <p class="sub">Claude Desktop, Cursor, ZCode &amp; friends use the same stdio entry.</p>
    <pre class="snippet" id="snip-json"><code>${escapeHtml(desktopJsonSnippet(info))}</code>${copyButton("snip-json")}</pre>
    <p class="note">MCP Inspector: <b>npx @modelcontextprotocol/inspector node "${escapeHtml(info.stdioEntry)}"</b></p>
  </section>

  <section class="accent-pink">
    <h2>④ Watermark shield &amp; delivery</h2>
    <p class="sub">Every finished Flow clip is scrubbed before it lands on disk.</p>
    <div class="flow">
      <span class="flow-step">Flow render</span><span class="flow-arrow">→</span>
      <span class="flow-step">Quality check</span><span class="flow-arrow">→</span>
      <span class="flow-step">Watermark removed</span><span class="flow-arrow">→</span>
      <span class="flow-step">Delivered to IDE</span>
    </div>
    <table>
      <tr><th>What</th><th>Where</th></tr>
      <tr><td>Clean video</td><td><code>${outputDir}\\&lt;job-id&gt;\\final\\video.mp4</code></td></tr>
      <tr><td>Original (watermarked) archive</td><td><code>${outputDir}\\&lt;job-id&gt;\\source\\</code></td></tr>
      <tr><td>Job history / prompts / QC</td><td><code>${outputDir}\\&lt;job-id&gt;\\</code> + <code>flow://video-jobs</code></td></tr>
      <tr><td>REST health check</td><td><code>${httpBaseUrl}/v1/health</code></td></tr>
    </table>
    <p class="note">MCP responses include <b>delivery.localPath</b> — the absolute path your agent opens directly in the IDE. Removal is best-effort: if both engines fail, the original clip is still delivered and the job records <b>output.watermark.error</b>.</p>
  </section>

  <section>
    <h2>⑤ Environment reference</h2>
    <table>
      <tr><th>Variable</th><th>Default</th><th>Purpose</th></tr>
      <tr><td><code>FLOW_TRANSPORT</code></td><td><code>stdio</code></td><td><b>both</b> = MCP over stdio + HTTP in one process; <b>http</b> = HTTP only.</td></tr>
      <tr><td><code>FLOW_HTTP_PORT</code></td><td><code>4318</code></td><td>Port for the /mcp endpoint, this page and the REST API.</td></tr>
      <tr><td><code>FLOW_HTTP_TOKEN</code></td><td>—</td><td>Bearer token required by the HTTP surface (≥ 24 chars).</td></tr>
      <tr><td><code>FLOW_WATERMARK_REMOVAL</code></td><td><code>true</code></td><td>Turn the watermark shield on/off.</td></tr>
      <tr><td><code>FLOW_WATERMARK_METHOD</code></td><td><code>auto</code></td><td><code>inpaint</code> (OpenCV), <code>ffmpeg</code> (delogo) or auto (inpaint → delogo).</td></tr>
      <tr><td><code>FFMPEG_PATH</code> / <code>PYTHON_PATH</code></td><td>PATH lookup</td><td>Explicit binary paths for the two removal engines.</td></tr>
      <tr><td><code>FLOW_OUTPUT_DIR</code></td><td><code>outputs</code></td><td>Where finished videos land, relative to the workspace.</td></tr>
    </table>
  </section>

  <section>
    <h2>⑥ Tools on this server (${info.tools.length})</h2>
    <div class="tools">
${toolCards}
    </div>
  </section>

  <footer>loopback-only · manual Google sign-in · no passwords, cookies or OTP codes ever pass through this server</footer>
</div>
<script>
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var snippet = document.getElementById(button.getAttribute("data-copy"));
      if (!snippet) return;
      var text = snippet.querySelector("code").textContent;
      navigator.clipboard.writeText(text).then(function () {
        button.classList.add("done");
        button.textContent = "COPIED!";
        setTimeout(function () {
          button.classList.remove("done");
          button.textContent = "COPY";
        }, 1600);
      });
    });
  });
</script>
</body>
</html>`;
}
