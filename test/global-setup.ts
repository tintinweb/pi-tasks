/** Clears the scratch home the suite ran against. Shared by every worker, so it
 *  can only be removed once they have all finished. */

import { rmSync } from "node:fs";
import { TEST_HOME } from "./setup.js";

export function teardown(): void {
  rmSync(TEST_HOME, { recursive: true, force: true });
}
