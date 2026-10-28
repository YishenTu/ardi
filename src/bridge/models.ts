// Turns pi's model objects into Ardi's ModelInfo. The thinking-level rules are
// adapted from Claudian (src/providers/pi/models.ts).

import { THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../chat";

// Levels a reasoning model gets when pi doesn't say otherwise.
const DEFAULT_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

type PiModel = { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> };

function isLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

// `thinkingLevelMap` adds levels (xhigh, max) and turns some off (mapped to null).
function thinkingLevels(model: PiModel): ThinkingLevel[] {
  const map = model.thinkingLevelMap ?? {};
  if (!model.reasoning && !Object.keys(map).length) return ["off"];
  const levels = new Set<ThinkingLevel>(DEFAULT_LEVELS);
  for (const [level, mapped] of Object.entries(map)) {
    if (!isLevel(level)) continue;
    if (mapped === null) levels.delete(level);
    else levels.add(level);
  }
  return THINKING_LEVELS.filter((level) => levels.has(level));
}

export function toModelInfo(models: PiModel[]): ModelInfo[] {
  return models.map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id, thinkingLevels: thinkingLevels(m) }));
}
