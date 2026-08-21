// <agent-dir>/tasks-config.json provides global defaults.
// <cwd>/.pi/tasks-config.json provides project overrides.
//
// Configuration is data, never code: there is deliberately no executable config
// file, because `.pi/` lives inside cloned repositories. Custom sort orders are
// expressed as JSON sort specs — see task-sort.ts; status glyphs are plain JSON
// strings — see task-icons.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskIconsConfig } from "./task-icons.js";
import type { TaskSortOrder } from "./task-sort.js";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  collapseCompleted?: boolean;           // default: false
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: TaskSortOrder;             // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
  icons?: TaskIconsConfig;               // default: see task-icons.ts
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
  // `icons` is a group of independent settings, not one value, so it merges a level
  // deeper than the rest: a project file overriding one icon keeps the global ones.
  // Guarded, so a config with no icons at all does not grow an empty object that
  // saveTasksConfig would then write out as a project override.
  if (globalConfig.icons || projectConfig.icons) {
    merged.icons = { ...globalConfig.icons, ...projectConfig.icons };
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
      key !== "icons" && differs(globalConfig[key as keyof TasksConfig], value)
    ),
  );
  // Icons are diffed per icon to match how they are merged. Comparing the group as
  // one value would write every inherited icon into the project file as soon as a
  // single one differed.
  const iconOverrides = Object.entries(config.icons ?? {}).filter(([icon, glyph]) =>
    differs(globalConfig.icons?.[icon as keyof TaskIconsConfig], glyph)
  );
  if (iconOverrides.length > 0) projectOverrides.icons = Object.fromEntries(iconOverrides);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(projectOverrides, null, 2));
}
