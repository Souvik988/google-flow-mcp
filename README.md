# Google Flow MCP

A production-grade [Model Context Protocol](https://modelcontextprotocol.io) server that turns Google Flow (Veo / Gemini) into a durable, IDE-native media engine: **video and image generation jobs through your own Google account, automatic finishing, and clean local delivery** — with a job system built for agents (idempotency, progress timelines, crash recovery, self-healing retries).

Point Codex, Claude Code, Cursor, ZCode, or any MCP client at this repo and generating media becomes a tool call.

```
You:     "Generate a 10s 16:9 video of a red fox in a misty forest."
Agent:   generate_video(...)  →  job id  →  get_video_job(...) until COMPLETED
         →  C:\...\outputs\<job-id>\final\video.mp4   (finished, delivery-ready)
```

---

## Why this exists

- **Agentic by design** — every generation is a *durable job* with a state machine (`CREATED → … → COMPLETED`), an event timeline, idempotency keys, cancellation, crash recovery, and a self-healing `recover_video_job`. Agents can poll, resume, and reason about failures instead of babysitting a browser.
- **Everything Flow offers** — Video mode (4/6/8/10 s, 16:9 / 9:16 / 1:1 / 3:4 / 4:3, model selection) **and Image mode** (all five ratios, x1–x4 variations). Ask the agent to call `flow_capabilities` for the live capability sheet.
- **Automatic finishing pipeline** — every finished render goes through technical QC and a finishing stage before delivery. The delivered file in `outputs/<job-id>/final/` is the finished asset; the raw provider download stays archived under `outputs/<job-id>/source/`.
- **Your account, your credits** — drives a real, manually-authenticated Chrome profile. No API keys to Google, no credentials in configs or logs, no passwords ever handled by the server.
- **Local-first** — outputs land on your disk with absolute paths returned to the agent; optional loopback HTTP API + `/connect` setup page for browser-based clients.

## Quick start (humans)

Requirements: **Node ≥ 20**, **Python 3.10+** with `pip install -r requirements.txt`, **FFmpeg** on PATH (or set `FFMPEG_PATH`), and **Google Chrome**.

```bash
git clone https://github.com/Souvik988/google-flow-mcp.git
cd google-flow-mcp
npm install
npm run build
cp .env.example .env        # optional: adjust to taste
```

Sign in once (opens a visible Chrome window on your automation profile):

```bash
npm run host                # starts the local API host (port 4318)
# then open http://127.0.0.1:4318/connect and follow the sign-in step,
# or simply call the flow_browser_login tool from your agent
```

## Quick start (IDE agents)

Tell your agent:

> Set up https://github.com/Souvik988/google-flow-mcp as an MCP server. Clone it, run `npm install && npm run build`, then register it per `AGENT_GUIDE.md` in the repo root.

Or add it yourself — the stdio entry is `dist/asset-mcp-main.js`:

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.google-flow]
command = "node"
args = ['C:\path\to\google-flow-mcp\dist\asset-mcp-main.js']
```

**Claude Desktop / Cursor / ZCode** (JSON form):
```json
{
  "mcpServers": {
    "google-flow": { "command": "node", "args": ["C:/path/to/google-flow-mcp/dist/asset-mcp-main.js"] }
  }
}
```

More snippets in [`examples/`](examples/). Restart the IDE after adding.

## The tools (45)

| Area | Tools |
|---|---|
| **Video generation** | `generate_video`, `get_video_job`, `get_video_status`, `list_video_jobs`, `cancel_video_job`, `refine_video`, `regenerate_video`, `recover_video_job`, `video_system_health` |
| **Image generation** | `generate_image` (all ratios, x1–x4, Ingredients references) |
| **Capability discovery** | `flow_capabilities` — live sheet of modes, ratios, durations, models, finishing engines, delivery layout |
| **Browser session** | `flow_browser_login`, `flow_browser_check_session`, `flow_browser_close`, `flow_screenshot` |
| **Google Workspace** | Gmail (4), Drive (5), Sheets (4), Docs (3), Calendar (4) |
| **Legacy bridge** | `trigger_flow`, `list_flows`, `get_flow_status`, `create_flow`, `delete_flow`, `download_flow_video`, `list_videos` |

Key parameters: `prompt` (director-style), `duration` (`4s|6s|8s|10s`), `aspectRatio` (`16:9|9:16|1:1|3:4|4:3`), `model`, `referenceImagePaths` (up to 5 local images, uploaded through Flow's Ingredients drawer), `idempotencyKey`, `waitForCompletion`.

## Architecture

```
src/
├─ asset-mcp-main.ts        # stdio entry (what IDEs launch)
├─ asset-host-main.ts       # HTTP host entry (asset API + /mcp + /connect)
├─ mcp-server.ts            # tool registry (45 tools, 3 resources)
├─ http-api.ts              # loopback REST + streamable-HTTP MCP endpoint
├─ connect-page.ts          # /connect setup page (URLs + copy-paste configs)
├─ browser-controller.ts    # persistent Chrome profile, clean sign-in dance
├─ manual-chrome.ts         # spawns Chrome (automation + clean-sign-in modes)
└─ video/
   ├─ orchestrator.ts       # job worker: submit → retrieve → QC → finish → deliver
   ├─ job-store.ts          # durable JSON job store (atomic writes)
   ├─ state-machine.ts      # explicit transition table (contract-tested)
   ├─ google-flow-provider.ts  # the only module that knows Flow's DOM
   ├─ quality-control.ts    # ffprobe-backed technical QC (+ image QC)
   ├─ watermark-remover.ts  # finishing engines + orchestration
   ├─ job-recovery.ts       # staged-clip-first salvage, no double credit spend
   ├─ asset-manager.ts      # job directories, trusted-host downloads
   └─ creative-brief.ts, prompt-compiler.ts, priority-queue.ts, …
scripts/
├─ remove_watermark_v2.py   # finishing engine v3 (registered reconstruction)
└─ remove_watermark.py      # finishing engine v1 (regional, fallback)
```

**Job lifecycle:** `CREATED → PREPARING → SUBMITTING → QUEUED → GENERATING → GENERATED → RETRIEVING → VALIDATING → QUALITY_CHECKING → POST_PROCESSING → QUALITY_CHECKING → COMPLETED` — with explicit failure classes (`AUTH_REQUIRED`, `UI_CHANGED`, `DOWNLOAD_FAILED`, `TIMEOUT`, …) instead of mystery hangs. The full choreography is contract-locked by a walk test.

**Finishing pipeline (every job, on by default):** after technical QC, each render passes through the finishing stage before it lands in `final/`. Engine order (`FLOW_WATERMARK_METHOD=auto`): registered reconstruction → OpenCV inpainting → FFmpeg patch. The stage records its outcome on the job (`output.watermark`) and is best-effort by design: a failed pass never throws away a paid generation. There is deliberately **no standalone finishing tool** — it is part of the pipeline, not a decision the calling agent makes.

**Recovery:** a job that finished generating but failed during download can always be salvaged — `recover_video_job` (or `npm run recover <jobId>`) reuses the already-staged asset when present and otherwise reattaches to the open Flow tab. It never submits a new generation, so credits are never spent twice.

## Security model

- Authentication is a **one-time manual sign-in** in a visible Chrome window. The server never accepts, types, stores, or logs Google passwords, TOTP secrets, cookies, or OTP codes.
- Downloads are restricted to Google-owned hosts (`google.com`, `googleusercontent.com`, `googlevideo.com`, `flow-content.google`); redirects are validated per hop.
- The HTTP surface binds loopback only and requires a ≥24-char bearer token. Put remote access behind your own authenticated proxy if you need it.
- Paths are confined to the workspace; state and outputs live under the repo.

## Configuration

See [`.env.example`](.env.example) for every variable. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `FLOW_TRANSPORT` | `stdio` | `both` = stdio MCP + HTTP API in one process |
| `FLOW_HTTP_PORT` / `FLOW_HTTP_TOKEN` | `4318` / — | Local API + `/connect` page + `/mcp` endpoint |
| `FLOW_DEFAULT_VIDEO_MODEL` | `gemini-omni-flash` | `veo-3.1-fast` / `veo-3.1-quality` also available |
| `FLOW_WATERMARK_REMOVAL` | `true` | Finishing stage toggle |
| `FLOW_WATERMARK_METHOD` | `auto` | `unblend` / `inpaint` / `ffmpeg` |
| `PYTHON_PATH` / `FFMPEG_PATH` | PATH | Explicit binaries for the finishing engines |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "This browser or app may not be secure" at Google sign-in | Already handled: `flow_browser_login` opens a clean (non-automation) Chrome for sign-in, then reconnects. Just complete the sign-in and close the window. |
| Job stuck non-terminal / `DOWNLOAD_FAILED` | Call `recover_video_job` — it salvages the paid render without resubmitting. |
| `AUTH_REQUIRED` | Session expired → `flow_browser_login` again. |
| `UI_CHANGED` | Flow's DOM moved → run `npm run build` after pulling updates. |
| Port 4318 busy | Another host is running; `FLOW_HTTP_PORT` to change. |

## Development

```bash
npm run typecheck && npm test && npm run build
```

Tests cover the state machine (full-choreography walk), the finishing engines (with a synthetic process seam), the capability/allowlist surface, the connect page, and the job store.

## License

MIT — see [LICENSE](LICENSE).
