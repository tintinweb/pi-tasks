import { join, resolve } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type TaskScope = "memory" | "session" | "project";
export type TaskStorageLocation = "local" | "global";

export function getProjectStorageKey(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getTaskStorageDir(cwd: string, storageLocation: TaskStorageLocation, agentDir = getAgentDir()): string {
  if (storageLocation === "global") {
    return join(agentDir, "extensions", "pi-tasks", getProjectStorageKey(cwd), "tasks");
  }
  return join(cwd, ".pi", "tasks");
}

export function resolveTaskStorePath(options: {
  cwd?: string;
  taskScope?: TaskScope;
  storageLocation?: TaskStorageLocation;
  sessionId?: string;
  piTasks?: string;
  agentDir?: string;
}): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const taskScope = options.taskScope ?? "session";
  const storageLocation = options.storageLocation ?? "local";
  const piTasks = options.piTasks;

  if (piTasks === "off") return undefined;
  if (piTasks?.startsWith("/")) return piTasks;
  if (piTasks?.startsWith(".")) return resolve(cwd, piTasks);
  if (piTasks) return piTasks;
  if (taskScope === "memory") return undefined;

  const tasksDir = getTaskStorageDir(cwd, storageLocation, options.agentDir);
  if (taskScope === "session" && options.sessionId) {
    return join(tasksDir, `tasks-${options.sessionId}.json`);
  }
  if (taskScope === "session") return undefined; // no session ID yet, start in-memory
  return join(tasksDir, "tasks.json");
}
