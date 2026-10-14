import type { CompiledPrompt, CreativeBrief } from "./types.js";

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function addSection(lines: string[], label: string, values: Array<string | undefined>): void {
  const resolved = unique(values.filter((value): value is string => Boolean(value)));
  if (resolved.length) lines.push(`${label}: ${resolved.join("; ")}.`);
}

/**
 * Compiles a concise Flow-ready production prompt. The raw instruction comes
 * first, so explicit user language remains authoritative over enrichment.
 */
export function compileFlowPrompt(brief: CreativeBrief): CompiledPrompt {
  const lines = [`Director's required brief: ${brief.sourceInstruction}.`];
  addSection(lines, "Subject", [brief.subject.primary, brief.subject.description]);
  addSection(lines, "Environment", [brief.scene.environment, brief.scene.background]);
  addSection(lines, "Action", [brief.action.primary, brief.motion.physics]);
  addSection(lines, "Camera", [
    brief.camera.shotType,
    brief.camera.composition,
    brief.camera.position,
    brief.camera.movement,
    brief.camera.lensFeeling,
  ]);
  addSection(lines, "Lighting and palette", [brief.lighting.direction, brief.lighting.timeOfDay, brief.style.palette]);
  addSection(lines, "Look", [brief.style.visual, brief.style.realism, brief.style.atmosphere]);
  addSection(lines, "Continuity", [brief.continuity.character, brief.continuity.object, brief.continuity.scene]);
  addSection(lines, "Audio", [brief.audio.dialogue, brief.audio.sound]);
  lines.push(`Output: ${brief.output.duration}, ${brief.output.aspectRatio} frame.`);

  const negative = unique(brief.negativeConstraints);
  if (negative.length) lines.push(`Avoid: ${negative.join("; ")}.`);

  return {
    text: lines.join("\n"),
    negativePrompt: negative.length ? negative.join(", ") : undefined,
    constraintsApplied: unique(brief.constraints),
  };
}

export function buildRefinementDirective(brief: CreativeBrief, reportReason: string): string {
  const base = "Regenerate while preserving the approved subject, scene, framing, and explicit constraints.";
  if (brief.camera.locked) {
    return `${base} Correction: tripod-locked static camera; absolutely no pan, tilt, dolly, zoom, orbit, handheld motion, reframing, or digital camera movement. Quality issue: ${reportReason}`;
  }
  return `${base} Correction for the detected mismatch: ${reportReason}`;
}
