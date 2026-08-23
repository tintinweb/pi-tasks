/**
 * Runs before every test file.
 *
 * Session task files, shared named lists and pi's global tasks-config all
 * resolve from pi's agent directory, so without this the suite reads and writes
 * the real `~/.pi/` of whoever runs it — picking up their settings and leaving
 * files behind. Point HOME at a scratch directory instead; the paths under test
 * stay exactly the ones that ship.
 *
 * Clearing PI_CODING_AGENT_DIR matters as much as redirecting HOME:
 * `getAgentDir()` consults the environment first, so a contributor who has it
 * set would have the suite escape the scratch directory entirely.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = join(tmpdir(), "pi-tasks-test-home");

mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME; // homedir() reads this one on Windows
delete process.env.PI_CODING_AGENT_DIR;
