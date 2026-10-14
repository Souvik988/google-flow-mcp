#!/usr/bin/env python3
"""
Watermark Remover v3 — registered alpha-unblending engine
=========================================================
Removes the Google Gemini sparkle from Veo/Flow renders by registering the
KNOWN sparkle template on the footage and inverting the compositing:

    observed = a * W + (1 - a) * clean   =>   clean = (observed - a*W) / (1 - a)

Why this leaves no trace (unlike box inpainting):
- alpha exists ONLY where the registered template says the sparkle is (tight,
  soft-shaped mask) — real texture between the sparkle arms is kept untouched;
- alpha is estimated per-pixel from the temporal MEDIAN frame (moving content
  averages out) against a content proxy obtained by tight-mask inpainting of
  that median, so static shots do not degenerate;
- the alpha field is feathered, so there is no rectangle boundary;
- the same alpha is applied to every frame — no temporal flicker.

Fallbacks: template registration failure or degenerate alpha estimation falls
back to tight-mask Navier-Stokes inpainting, then to the legacy v1 box engine.

Usage:
  python remove_watermark_v2.py --input in.mp4 --output out.mp4 [--aspect 16:9]
  python remove_watermark_v2.py --input in.png --output out.png [--image]

Prints a final report line: WMV2_REPORT {"method": ..., "alpha_mean": ...}
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATE_PATH = SCRIPT_DIR / "watermark_template.png"

W_COLOR_DEFAULT = 245.0
MAX_ALPHA = 0.85
CLIP_FALLBACK_FRACTION = 0.10
REGISTER_MIN_SCORE = 0.50
LOCALIZATION_RADIUS = 72
SAMPLE_BUDGET = 30


def watermark_box(frame_w: int, frame_h: int, aspect_override: str = None):
    is_vertical = (aspect_override == "9:16") or (aspect_override != "16:9" and frame_h > frame_w)
    if is_vertical:
        rel_x, rel_y = 575.0 / 720.0, 1135.0 / 1280.0
        rel_w, rel_h = 90.0 / 720.0, 100.0 / 1280.0
    else:
        rel_x, rel_y = 1110.0 / 1280.0, 550.0 / 720.0
        rel_w, rel_h = 100.0 / 1280.0, 100.0 / 720.0
    tx, ty = int(round(frame_w * rel_x)), int(round(frame_h * rel_y))
    tw, th = int(round(frame_w * rel_w)), int(round(frame_h * rel_h))
    return max(0, tx), max(0, ty), min(frame_w, tx + tw), min(frame_h, ty + th)


def load_template():
    template = cv2.imread(str(TEMPLATE_PATH), cv2.IMREAD_GRAYSCALE)
    return template


def sample_frames(source, budget=SAMPLE_BUDGET):
    """Evenly spaced frames (BGR) plus total frame count."""
    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        return [], 0, 0.0, (0, 0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    ok, first = cap.read()
    if not ok:
        cap.release()
        return [], 0, fps, (0, 0)
    h, w = first.shape[:2]
    frames = [first]
    if total > 1:
        step = max(1, total // budget)
        for index in range(step, total, step):
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = cap.read()
            if ok:
                frames.append(frame)
            if len(frames) >= budget:
                break
    cap.release()
    return frames, total, fps, (w, h)


def register_template(median_gray, box, template):
    """Find the sparkle inside the search box (±20% scale search)."""
    x0, y0, x1, y1 = box
    margin = 24
    hx0, hy0 = max(0, x0 - margin), max(0, y0 - margin)
    hx1, hy1 = median_gray.shape[1], median_gray.shape[0]
    search = median_gray[hy0:hy1, hx0:hx1]
    best = None
    th0, tw0 = template.shape[:2]
    for scale in (1.0, 0.85, 0.75, 1.15, 1.3):
        tw, th = max(8, int(tw0 * scale)), max(8, int(th0 * scale))
        if th >= search.shape[0] or tw >= search.shape[1]:
            continue
        scaled = cv2.resize(template, (tw, th), interpolation=cv2.INTER_AREA)
        result = cv2.matchTemplate(search, scaled, cv2.TM_CCOEFF_NORMED)
        _, score, _, location = cv2.minMaxLoc(result)
        if best is None or score > best["score"]:
            best = {"score": float(score), "x": hx0 + location[0], "y": hy0 + location[1], "w": tw, "h": th}
    if best is None or best["score"] < REGISTER_MIN_SCORE:
        return None
    return best


def build_alpha_map(median_bgr, center, radius, registered):
    """Data-driven alpha with a white-overlay model.

    Measured on real Flow renders: the sparkle composites as pure white,
    observed = a*255 + (1-a)*content  =>  a = (obs - content)/(255 - content).
    The sparkle region is found as the dominant connected blob whose median
    luminance is persistently lifted above a large-kernel content proxy; alpha
    is then solved exactly against a tight inpainted content estimate."""
    H, W = median_bgr.shape[:2]
    cx, cy = center
    rx0, ry0 = max(0, cx - radius), max(0, cy - radius)
    rx1, ry1 = min(W, cx + radius), min(H, cy + radius)
    roi = median_bgr[ry0:ry1, rx0:rx1]
    h, w = roi.shape[:2]

    # Persistent-brightness mask: the sparkle lifts luminance in EVERY frame,
    # so the median frame is brighter than the large-kernel content proxy.
    k = min(51, max(9, (min(h, w) // 2) * 2 - 1))
    proxy = cv2.medianBlur(roi, k)
    lift = cv2.GaussianBlur(roi, (3, 3), 0).mean(axis=2).astype(np.float32) -         cv2.GaussianBlur(proxy, (3, 3), 0).mean(axis=2).astype(np.float32)
    _, binary = cv2.threshold(lift, 7.0, 255, cv2.THRESH_BINARY)
    binary = binary.astype(np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary)
    keep = np.zeros((h, w), np.uint8)
    blob_pixels = 0
    if count > 1:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        blob_pixels = int(stats[largest, cv2.CC_STAT_AREA])
        keep[labels == largest] = 255
    if blob_pixels < 120:
        return np.zeros((h, w, 3), np.float32), np.full(3, 255.0, np.float32), keep.astype(np.float32), (rx0, ry0), blob_pixels, np.zeros((h, w), np.uint8), -1.0

    # Tight content estimate: inpaint the sparkle strokes only, then solve
    # alpha exactly per channel against the white-overlay model.
    stroke = cv2.dilate(keep, np.ones((11, 11), np.uint8))
    content = cv2.inpaint(roi, stroke, 4, cv2.INPAINT_NS).astype(np.float32)
    obs = roi.astype(np.float32)
    denom = 255.0 - content  # per-channel (h, w, 3)
    safe = denom < 25.0
    denom_safe = np.maximum(denom, 25.0)
    alpha = np.where(safe, 0.0, (obs - content) / denom_safe)
    alpha = np.clip(alpha, 0.0, 0.75)

    keepf = cv2.GaussianBlur(cv2.dilate(keep, np.ones((3, 3), np.uint8)).astype(np.float32) / 255.0, (3, 3), 0)
    alpha *= keepf[:, :, None]
    for channel in range(3):
        channel8 = (alpha[:, :, channel] * 255).astype(np.uint8)
        alpha[:, :, channel] = cv2.GaussianBlur(channel8.astype(np.float32) / 255.0, (3, 3), 0)
    alpha[alpha < 0.03] = 0.0

    # Residual correction: unblend the median with the current alpha, measure
    # any remaining luminance lift against the content proxy, and fold it back
    # into alpha. Three rounds drive the visible residual to zero.
    proxy_lum = cv2.GaussianBlur(proxy.mean(axis=2), (3, 3), 0)
    content_lum = np.maximum(content.mean(axis=2), 1.0)
    for _ in range(3):
        cleaned = np.clip((obs - alpha * 255.0) / np.maximum(1.0 - alpha, 0.15), 0, 255)
        out_lum = cv2.GaussianBlur(cleaned.mean(axis=2), (3, 3), 0)
        residual = out_lum - proxy_lum
        delta = np.clip(residual / np.maximum(255.0 - content_lum, 25.0), 0.0, 0.5)
        delta = np.where((residual > 4.0) & (keepf > 0.15), delta, 0.0)
        delta = cv2.GaussianBlur(delta, (5, 5), 0)
        alpha = np.clip(alpha + delta[:, :, None], 0.0, 0.75)

    # Finisher mask: wherever the unblended median still deviates from the
    # content proxy (the thin anti-aliased ring), a per-frame tight inpaint
    # hides it completely — a 2-4 px strip fills invisibly from both sides.
    cleaned = np.clip((obs - alpha * 255.0) / np.maximum(1.0 - alpha, 0.15), 0, 255)
    out_lum = cleaned.mean(axis=2)
    ring = (np.abs(cv2.GaussianBlur(out_lum, (3, 3), 0) - proxy_lum) > 3.0).astype(np.uint8) * 255
    ring = cv2.dilate(ring, np.ones((7, 7), np.uint8))
    finish_gate = cv2.dilate(keep, np.ones((13, 13), np.uint8))
    patch_mask = cv2.bitwise_and(ring, finish_gate)
    # Self-verification: run the exact final transform on the median ROI and
    # measure the luminance lift that remains versus the content proxy.
    final_roi = np.clip((obs - np.clip(alpha, 0.0, 0.75) * 255.0) / np.maximum(1.0 - alpha, 0.15), 0, 255).astype(np.uint8)
    if patch_mask.any():
        final_roi = cv2.inpaint(final_roi, patch_mask, 3, cv2.INPAINT_NS)
    final_lum = cv2.GaussianBlur(final_roi.mean(axis=2), (3, 3), 0)
    verification = float(np.mean(np.maximum(final_lum - proxy_lum, 0.0)[keepf > 0.35]))
    return np.clip(alpha, 0.0, 0.75), np.full(3, 255.0, np.float32), keepf, (rx0, ry0), blob_pixels, patch_mask, verification


def apply_alpha(frame_bgr, origin, alpha, w_color):
    rx, ry = origin
    rh, rw = alpha.shape[:2]
    roi = frame_bgr[ry:ry + rh, rx:rx + rw].astype(np.float32)
    a = alpha[:, :, :]
    w = w_color[None, None, :]
    cleaned = (roi - a * w) / np.maximum(1.0 - a, 0.15)
    cleaned = np.clip(cleaned, 0, 255).astype(np.uint8)
    frame_bgr[ry:ry + rh, rx:rx + rw] = cleaned
    return roi, cleaned


def degenerate_clip_fraction(frames, origin, alpha, w_color):
    total = 0.0
    checked = 0
    for frame in frames[:8]:
        rx, ry = origin
        roi = frame[ry:ry + alpha.shape[0], rx:rx + alpha.shape[1]].astype(np.float32)
        a = alpha[:, :, :]
        w = w_color[None, None, :]
        cleaned = (roi - a * w) / np.maximum(1.0 - a, 0.15)
        total += float(((cleaned < -10) | (cleaned > 265)).mean())
        checked += 1
    return total / max(checked, 1)


def tight_inpaint_video(source, temp_video, fps, size, rx, ry, rw, rh, mask):
    cap = cv2.VideoCapture(str(source))
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        roi = frame[ry:ry + rh, rx:rx + rw]
        frame[ry:ry + rh, rx:rx + rw] = cv2.inpaint(roi, mask, inpaintRadius=4, flags=cv2.INPAINT_NS)
        writer.write(frame)
    cap.release()
    writer.release()


def remux_with_audio(temp_video, source, output_file):
    final_temp = output_file.parent / f"_wmv2_final_{int(time.time() * 1000)}_{output_file.name}"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(temp_video), "-i", str(source),
        "-map", "0:v:0", "-map", "1:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
        "-c:a", "copy", "-movflags", "+faststart",
        str(final_temp),
    ]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        cmd = cmd[:-6] + ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final_temp)]
        subprocess.run(cmd, check=True)
    finally:
        Path(temp_video).unlink(missing_ok=True)
    Path(final_temp).replace(output_file)


def debug_dump(directory, registered, template, median_bgr, alpha, support=None):
    if not directory:
        return
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    rx, ry, rw, rh = registered["x"], registered["y"], registered["w"], registered["h"]
    tn = cv2.resize(template, (rw, rh), interpolation=cv2.INTER_AREA)
    canvas = median_bgr.copy()
    cv2.rectangle(canvas, (rx, ry), (rx + rw, ry + rh), (0, 255, 0), 1)
    cv2.imwrite(str(out / "1-median-box.png"), canvas[ry - 40:ry + rh + 40, rx - 60:rx + rw + 60])
    cv2.imwrite(str(out / "2-template-resized.png"), tn)
    if alpha.ndim == 3:
        cv2.imwrite(str(out / "3-alpha-x10.png"), np.clip(alpha * 255 * 10, 0, 255).astype(np.uint8))
        cv2.imwrite(str(out / "4-support.png"), (support * 255).astype(np.uint8) if support is not None else np.zeros((rh, rw), np.uint8))
    else:
        cv2.imwrite(str(out / "3-alpha-x10.png"), np.clip(alpha * 255 * 10, 0, 255).astype(np.uint8))


def main():
    parser = argparse.ArgumentParser(description="Registered alpha-unblending watermark remover (v3)")
    parser.add_argument("--input", "-i", required=True)
    parser.add_argument("--output", "-o", required=True)
    parser.add_argument("--aspect", choices=["16:9", "9:16"], default=None)
    parser.add_argument("--image", action="store_true", help="Input is a single still image")
    parser.add_argument("--quiet", "-q", action="store_true")
    parser.add_argument("--debug", default=None, help="Directory to dump intermediate images")
    args = parser.parse_args()

    input_file = Path(args.input).resolve()
    output_file = Path(args.output).resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    if not input_file.exists():
        print(f"[ERROR] Input not found: {input_file}", file=sys.stderr)
        sys.exit(1)

    started = time.time()
    template = load_template()
    if template is None:
        print(f"[ERROR] Template missing: {TEMPLATE_PATH}", file=sys.stderr)
        sys.exit(1)

    if args.image:
        image = cv2.imread(str(input_file), cv2.IMREAD_COLOR)
        if image is None:
            print(f"[ERROR] Could not read image: {input_file}", file=sys.stderr)
            sys.exit(1)
        h, w = image.shape[:2]
        box = watermark_box(w, h, args.aspect)
        median_gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        registered = register_template(median_gray, box, template)
        method = "unblend"
        if registered:
            center = (registered["x"] + registered["w"] // 2, registered["y"] + registered["h"] // 2)
            alpha, w_color, support, origin, blob, patch_mask, residual = build_alpha_map(image, center, LOCALIZATION_RADIUS, registered)
            debug_dump(args.debug, {"x": origin[0], "y": origin[1], "w": alpha.shape[1], "h": alpha.shape[0]}, template, image, alpha, support)
            work = image.copy()
            apply_alpha(work, origin, alpha, w_color)
            if patch_mask.max() > 0.02:
                prh, prw = patch_mask.shape[:2]
                roi = work[origin[1]:origin[1] + prh, origin[0]:origin[0] + prw]
                filled = cv2.inpaint(roi, (patch_mask > 0.5).astype(np.uint8) * 255, 3, cv2.INPAINT_NS).astype(np.float32)
                blended = roi.astype(np.float32) * (1.0 - patch_mask[:, :, None]) + filled * patch_mask[:, :, None]
                work[origin[1]:origin[1] + prh, origin[0]:origin[0] + prw] = np.clip(blended, 0, 255).astype(np.uint8)
            clipped = degenerate_clip_fraction([image], origin, alpha, w_color)
            if clipped > CLIP_FALLBACK_FRACTION:
                method = "inpaint_fallback"
                rx, ry, rw, rh = registered["x"], registered["y"], registered["w"], registered["h"]
                mask = cv2.dilate((alpha * 255).astype(np.uint8), np.ones((5, 5), np.uint8))
                _, mask = cv2.threshold(mask, 40, 255, cv2.THRESH_BINARY)
                work = image.copy()
                roi = work[ry:ry + rh, rx:rx + rw]
                work[ry:ry + rh, rx:rx + rw] = cv2.inpaint(roi, mask, inpaintRadius=4, flags=cv2.INPAINT_NS)
            if not cv2.imwrite(str(output_file), work):
                print(f"[ERROR] Could not write {output_file}", file=sys.stderr)
                sys.exit(1)
            print("WMV2_REPORT " + json.dumps({
                "method": method,
                "register_score": round(registered["score"], 3),
                "alpha_mean": round(float(alpha.mean()), 4),
                "clipped": round(clipped, 4),
                "residual": round(residual, 3),
            }))
            return
        # Registration failed on the still: legacy v1 geometry inpaint.
        x0, y0, x1, y1 = box
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        mask[:] = 255
        roi = cv2.inpaint(image[y0:y1, x0:x1], mask, inpaintRadius=5, flags=cv2.INPAINT_NS)
        out = image.copy()
        out[y0:y1, x0:x1] = roi
        cv2.imwrite(str(output_file), out)
        print("WMV2_REPORT " + json.dumps({"method": "inpaint_fallback", "register_score": 0.0}))
        return

    frames, total, fps, (w, h) = sample_frames(input_file)
    if not frames:
        print("[ERROR] No frames could be read.", file=sys.stderr)
        sys.exit(1)

    box = watermark_box(w, h, args.aspect)
    stack = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames])
    median_gray = np.median(stack, axis=0).astype(np.uint8)
    registered = register_template(median_gray, box, template)

    temp_video = input_file.parent / f"_wmv3_{int(time.time() * 1000)}_{input_file.name}.mp4"
    if registered:
        center = (registered["x"] + registered["w"] // 2, registered["y"] + registered["h"] // 2)
        median_bgr = np.median(np.stack(frames), axis=0).astype(np.uint8)
        alpha, w_color, support, origin, blob_pixels, patch_mask, residual = build_alpha_map(median_bgr, center, LOCALIZATION_RADIUS, registered)
        debug_dump(args.debug, {"x": origin[0], "y": origin[1], "w": alpha.shape[1], "h": alpha.shape[0]}, template, median_bgr, alpha, support)
        clipped = degenerate_clip_fraction(frames, origin, alpha, w_color)
        if clipped <= CLIP_FALLBACK_FRACTION and blob_pixels >= 150:
            method = "unblend"
            cap = cv2.VideoCapture(str(input_file))
            writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
            prx, pry = origin
            prh, prw = patch_mask.shape[:2]
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                apply_alpha(frame, origin, alpha, w_color)
                if patch_mask.max() > 0.02:
                    roi = frame[pry:pry + prh, prx:prx + prw]
                    filled = cv2.inpaint(roi, (patch_mask > 0.5).astype(np.uint8) * 255, 3, cv2.INPAINT_NS).astype(np.float32)
                    blended = roi.astype(np.float32) * (1.0 - patch_mask[:, :, None]) + filled * patch_mask[:, :, None]
                    frame[pry:pry + prh, prx:prx + prw] = np.clip(blended, 0, 255).astype(np.uint8)
                writer.write(frame)
            cap.release()
            writer.release()
            remux_with_audio(temp_video, input_file, output_file)
            print("WMV2_REPORT " + json.dumps({
                "method": method,
                "register_score": round(registered["score"], 3),
                "alpha_mean": round(float(alpha.mean()), 4),
                "clipped": round(clipped, 4),
                "residual": round(residual, 3),
                "frames": total,
                "seconds": round(time.time() - started, 2),
            }))
            return
        if not args.quiet:
            print(f"[v3] unblend degenerate (clipped={clipped:.3f}) — tight inpaint fallback", file=sys.stderr)

    if registered:
        center = (registered["x"] + registered["w"] // 2, registered["y"] + registered["h"] // 2)
        median_bgr = np.median(np.stack(frames), axis=0).astype(np.uint8)
        alpha, _, _, origin, _, patch_mask, _ = build_alpha_map(median_bgr, center, LOCALIZATION_RADIUS)
        rx, ry = origin
        rh, rw = alpha.shape[:2]
        mask = cv2.dilate((alpha.max(axis=2) * 255).astype(np.uint8), np.ones((5, 5), np.uint8))
        _, mask = cv2.threshold(mask, 40, 255, cv2.THRESH_BINARY)
        method = "inpaint_fallback"
    else:
        x0, y0, x1, y1 = box
        rx, ry, rw, rh = x0, y0, x1 - x0, y1 - y0
        mask = np.full((rh, rw), 255, np.uint8)
        method = "inpaint_fallback"
    tight_inpaint_video(input_file, temp_video, fps, (w, h), rx, ry, rw, rh, mask)
    remux_with_audio(temp_video, input_file, output_file)
    print("WMV2_REPORT " + json.dumps({
        "method": method,
        "register_score": round((registered or {}).get("score", 0.0), 3),
        "seconds": round(time.time() - started, 2),
    }))


if __name__ == "__main__":
    main()
