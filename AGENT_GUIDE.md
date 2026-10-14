# AGENT GUIDE — Google Flow MCP

This repo is an MCP server that drives Google Flow (Veo/Gemini) for video and
image generation through the user's own Google account. Read this before using
the tools. Per-IDE pointer files (CLAUDE.md, CODEX.md, AGENTS.md, CURSOR.md)
all point here.

## Operating rules

1. **Generation is asynchronous.** `generate_video` / `generate_image` return a
   job immediately (unless `waitForCompletion: true`). Keep calling
   `get_video_job` until `status` is `COMPLETED` or a terminal failure. Never
   present an asset before `COMPLETED`.
2. **Deliver only the finished file.** Use `delivery.localPath` from the
   completed job (`outputs/<job-id>/final/video.mp4` or `image.png`). Never
   deliver, link, or preview anything from `outputs/<job-id>/source/` or `tmp/`
   — those hold raw provider downloads and intermediates.
3. **Finishing is automatic.** Every job passes QC + the finishing pipeline
   before COMPLETED; `delivery.watermarkRemoved` tells you it ran. There is no
   standalone finishing tool and none is needed — do not look for one.
4. **Never resubmit to retry a failure.** If a job ends in `DOWNLOAD_FAILED`,
   `GENERATION_FAILED`, `GENERATED`, `RETRIEVING`, `RECOVERY_REQUIRED`, or hangs
   non-terminal for >5 minutes, call `recover_video_job` with its jobId. It
   salvages the paid render without spending credits again. Resubmitting the
   same prompt double-spends the user's credits.
5. **Check capabilities before assuming.** Call `flow_capabilities` when the
   user asks what Flow can do, or before promising a size/format. Ratios:
   16:9, 4:3, 1:1, 3:4, 9:16. Video durations: 4s/6s/8s/10s. Images: x1–x4.
   Models: gemini-omni-flash (default), veo-3.1-fast, veo-3.1-quality.
6. **Authentication is human.** If a job reports `AUTH_REQUIRED`, call
   `flow_browser_login` and tell the user: a normal Chrome window opens, they
   sign in there, close it, done. Never ask for Google credentials, cookies,
   or OTP codes — the server cannot and must not receive them.
7. **Idempotency.** Pass an `idempotencyKey` when the caller might retry the
   same request; duplicate submissions with the same key return the same job.
8. **One generation at a time.** Flow's composer is a single shared surface.
   Do not run parallel `generate_*` calls; submit, poll to completion, then
   submit the next.

## Delivery contract

A COMPLETED job response contains:

```json
{
  "status": "COMPLETED",
  "delivery": { "localPath": "C:/…/outputs/<job-id>/final/video.mp4",
                "fileName": "video.mp4", "watermarkRemoved": true },
  "output": { "finalPath": "…", "watermark": { "removed": true, "method": "unblend" } }
}
```

`delivery.localPath` is an absolute path — open it, copy it into the user's
project, or attach it. That is the whole delivery.

## Failure classes (all terminal states are safe to report verbatim)

| State | Meaning | Agent action |
|---|---|---|
| `AUTH_REQUIRED` | Google session expired | `flow_browser_login`, guide the human |
| `UI_CHANGED` | Flow's DOM moved | Report; a server update fixes it |
| `DOWNLOAD_FAILED` | Render finished, retrieval failed | `recover_video_job` |
| `GENERATION_FAILED` / `TIMEOUT` | Flow-side failure/deadline | Report; safe to retry once via a NEW job (new idempotencyKey) |
| `RECOVERY_REQUIRED` | Server restarted mid-job | `recover_video_job` |
| `QUALITY_REJECTED` / `INVALID_OUTPUT` | Technical QC failed | Report with the job's QC checks |
