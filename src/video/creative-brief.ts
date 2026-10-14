import type { CreativeBrief, OutputSpec } from "./types.js";

const CHANGE_ONLY_PATTERN = /\b(?:only|just)\s+(?:change|make|alter|update)\s+(.+)/i;
const NEGATIVE_PATTERNS = [
  /\b(?:avoid|without|no|do not|don't|never)\s+([^.;,!]+)/gi,
  /\b(?:remove|exclude)\s+([^.;,!]+)/gi,
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function appendUnique(target: string[], value: string): void {
  const normalized = normalizeText(value);
  if (normalized && !target.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
    target.push(normalized);
  }
}

function extractAfter(instruction: string, expression: RegExp): string | undefined {
  const match = instruction.match(expression);
  return match?.[1] ? normalizeText(match[1]) : undefined;
}

function cloneBrief(brief: CreativeBrief): CreativeBrief {
  return JSON.parse(JSON.stringify(brief)) as CreativeBrief;
}

export function createEmptyBrief(instruction: string, output: OutputSpec): CreativeBrief {
  return {
    subject: {},
    scene: {},
    action: {},
    camera: {},
    lighting: {},
    composition: {},
    style: {},
    motion: {},
    audio: {},
    continuity: {},
    constraints: [],
    negativeConstraints: [],
    output,
    sourceInstruction: normalizeText(instruction),
  };
}

/**
 * A deterministic, transparent interpreter for the production defaults. It never
 * fabricates a subject: the original director instruction remains the canonical
 * source and every inferred field is deliberately conservative.
 */
export function interpretDirectorInstruction(
  instruction: string,
  output: OutputSpec,
  priorBrief?: CreativeBrief,
): CreativeBrief {
  const brief = priorBrief ? cloneBrief(priorBrief) : createEmptyBrief(instruction, output);
  const source = normalizeText(instruction);
  brief.sourceInstruction = source;
  brief.output = output;

  const subject = extractAfter(source, /(?:^|\b)(?:a|an|the)?\s*(.+?)(?:\s+(?:in|at|on|against|inside|under)\s+)/i);
  if (subject && !brief.subject.primary) brief.subject.primary = subject;

  const scene = extractAfter(source, /\b(?:in|at|on|inside|under|against)\s+([^.,;]+)/i);
  if (scene) brief.scene.environment = scene;

  const action = extractAfter(source, /\b(?:is|are|while|as)\s+([^.,;]+)/i);
  if (action) brief.action.primary = action;

  if (/\b(?:locked camera|static camera|tripod[- ]locked|do not move the camera|camera should remain locked)\b/i.test(source)) {
    brief.camera.locked = true;
    brief.camera.movement = "Locked tripod camera; no pan, tilt, dolly, zoom, orbit, handheld movement, reframing, or digital camera motion.";
    appendUnique(brief.constraints, "Camera remains locked and static.");
  }

  const cameraMovement = extractAfter(source, /\b(?:camera|shot)\s+(?:should|will|to)?\s*(?:slowly )?(dolly|track|pan|tilt|orbit|crane|zoom)[^.,;]*/i);
  if (cameraMovement && !brief.camera.locked) brief.camera.movement = cameraMovement;

  const shotType = extractAfter(source, /\b(wide shot|close[- ]up|medium shot|over[- ]the[- ]shoulder|aerial shot|macro shot|establishing shot)\b/i);
  if (shotType) brief.camera.shotType = shotType;

  const lighting = extractAfter(source, /\b(warm(?:er)?|cool(?:er)?|golden hour|daylight|moonlit|nighttime|night|neon|soft|dramatic)\s+lighting\b/i);
  if (lighting) brief.lighting.direction = lighting;
  if (/\bnight(?:time)?\b/i.test(source)) brief.lighting.timeOfDay = "night";
  if (/\bday(?:time)?\b/i.test(source)) brief.lighting.timeOfDay = "day";

  const style = extractAfter(source, /\b(cinematic|photorealistic|realistic|documentary|commercial|animated|stylized)\b/i);
  if (style) brief.style.visual = style;

  if (/\b(?:walk naturally|natural movement|natural physics)\b/i.test(source)) {
    brief.motion.physics = "Natural, physically plausible movement and timing.";
  }

  if (/\b(?:keep everything else the same|same scene|previous prompt)\b/i.test(source)) {
    appendUnique(brief.constraints, "Preserve all prior approved details unless explicitly changed.");
  }

  for (const pattern of NEGATIVE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      appendUnique(brief.negativeConstraints, match[1]);
    }
  }
  if (brief.camera.locked) {
    appendUnique(brief.negativeConstraints, "camera movement");
  }

  appendUnique(brief.constraints, source);
  return brief;
}

/** Applies a follow-up as a delta. Explicit "only" directives do not erase unrelated state. */
export function applyCreativeDirective(
  previous: CreativeBrief,
  directive: string,
  output: OutputSpec = previous.output,
): CreativeBrief {
  const merged = interpretDirectorInstruction(directive, output, previous);
  const onlyMatch = directive.match(CHANGE_ONLY_PATTERN);
  if (onlyMatch) {
    appendUnique(merged.constraints, `Delta directive: only ${normalizeText(onlyMatch[1])}`);
  }
  if (/\b(?:regenerate|version\s+\d+)\b/i.test(directive)) {
    appendUnique(merged.constraints, "Regenerate as a new version; retain approved creative brief details.");
  }
  return merged;
}
