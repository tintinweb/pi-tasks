import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Global directory for session-scoped task state belonging to one workspace. */
export function sessionTasksDir(cwd: string): string {
  const projectKey = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(homedir(), ".pi", "tasks", "sessions", projectKey);
}

/** Default task file for one persisted session in a workspace. */
export function sessionTaskFile(cwd: string, sessionId: string): string {
  return join(sessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/** Previous default location, retained only as a migration source. */
export function legacySessionTaskFile(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

/**
 * Move one legacy workspace-local session file into global storage. Migration is
 * lazy, preserves the legacy file when the destination already exists, and never
 * overwrites global state. Empty legacy directories are removed when possible.
 */
export function migrateLegacySessionTaskFile(cwd: string, sessionId: string): void {
  const source = legacySessionTaskFile(cwd, sessionId);
  const destination = sessionTaskFile(cwd, sessionId);
  if (!existsSync(source) || existsSync(destination)) return;

  const temporary = `${destination}.migrate-${process.pid}-${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    // Publishing with a hard link is atomic and fails rather than replacing a
    // destination created by another process during the copy.
    linkSync(temporary, destination);
  } catch {
    return;
  } finally {
    try { unlinkSync(temporary); } catch { /* copy was never created */ }
  }

  try { unlinkSync(source); } catch { return; }
  try { rmdirSync(dirname(source)); } catch { return; }
  try { rmdirSync(dirname(dirname(source))); } catch { /* contains other project state */ }
}
