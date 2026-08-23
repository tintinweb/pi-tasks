// <agent-dir>/tasks-config.json provides global defaults.
// <cwd>/.pi/tasks-config.json provides project overrides.
//
// Configuration is data, never code: there is deliberately no executable config
// file, because `.pi/` lives inside cloned repositories. Custom sort orders are
// expressed as JSON sort specs — see task-sort.ts; the glyphs tasks are drawn with
// are plain JSON strings — see task-glyphs.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskGlyphsConfig } from "./task-glyphs.js";
import type { TaskSortOrder } from "./task-sort.js";

export interface TasksConfig {
  // "session" keeps per-session files in the workspace; "session-global" keeps them
  // under the agent directory instead. Same scope, different home — see task-paths.ts.
  taskScope?: "memory" | "session" | "session-global" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  collapseCompleted?: boolean;           // default: false
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: TaskSortOrder;             // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
  glyphs?: TaskGlyphsConfig;             // default: see task-glyphs.ts
}

const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

function readTasksConfig(configPath: string): TasksConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TasksConfig : {};
  } catch {
    return {};
  }
}

export function loadGlobalTasksConfig(agentDir = getAgentDir()): TasksConfig {
  return readTasksConfig(join(agentDir, "tasks-config.json"));
}

export function loadTasksConfig(cwd: string, agentDir = getAgentDir()): TasksConfig {
  const globalConfig = loadGlobalTasksConfig(agentDir);
  const projectConfig = readTasksConfig(join(cwd, ".pi", "tasks-config.json"));
  const merged = { ...globalConfig, ...projectConfig };
  // `glyphs` is a group of independent settings, not one value, so it merges a level
  // deeper than the rest: a project file overriding one glyph keeps the global ones.
  // Guarded, so a config with no glyphs at all does not grow an empty object that
  // saveTasksConfig would then write out as a project override.
  if (globalConfig.glyphs || projectConfig.glyphs) {
    merged.glyphs = { ...globalConfig.glyphs, ...projectConfig.glyphs };
  }
  return merged;
}

export function saveTasksConfig(config: TasksConfig, cwd: string, agentDir = getAgentDir()): void {
  const configPath = join(cwd, ".pi", "tasks-config.json");
  const globalConfig = loadGlobalTasksConfig(agentDir);
  // Compared as JSON so that object-valued settings (a custom sortOrder spec) are
  // matched by value; for the primitives this config holds it is equivalent to !==.
  const projectOverrides: Record<string, unknown> = Object.fromEntries(
    Object.entries(config).filter(([key, value]) =>
      key !== "glyphs" && differs(globalConfig[key as keyof TasksConfig], value)
    ),
  );
  // Glyphs are diffed one by one to match how they are merged. Comparing the group
  // as one value would write every inherited glyph into the project file as soon as
  // a single one differed.
  const glyphOverrides = Object.entries(config.glyphs ?? {}).filter(([name, glyph]) =>
    differs(globalConfig.glyphs?.[name as keyof TaskGlyphsConfig], glyph)
  );
  if (glyphOverrides.length > 0) projectOverrides.glyphs = Object.fromEntries(glyphOverrides);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
}
