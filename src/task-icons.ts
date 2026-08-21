/**
 * task-icons.ts — Status glyphs for the task widget and the /tasks menu.
 *
 * Icons are pure data — there is deliberately no executable config file, because
 * `.pi/` lives inside cloned repositories. A hand-edited config must never break
 * the widget, so anything unrecognised falls back to the built-in glyph.
 */

/** Icons as written in `tasks-config.json`; every key optional. */
export interface TaskIconsConfig {
  completed?: string;
  inProgress?: string;
  pending?: string;
  spinner?: string[];
}

/** A fully resolved icon set — what the render sites consume. */
export interface TaskIcons {
  completed: string;
  inProgress: string;
  pending: string;
  spinner: string[];
}

/** Star spinner frames for the animated active-task indicator. Claude Code's own
 *  spinner is a shorter mirrored sequence (`· ✢ ✳ ✶ ✻ ✽` and its reverse, with a
 *  ghostty variant); this walks the dingbat block instead. Deliberately ours. */
const DEFAULT_ICONS: TaskIcons = {
  completed: "✔",
  inProgress: "◼",
  pending: "◻",
  spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
};

/** A frame may be any non-empty string, not just one glyph — `⣾⣾`, `..` and an
 *  emoji with a variation selector are all valid frames. */
function isSpinner(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(frame => typeof frame === "string" && frame.length > 0);
}

/** Resolve configured icons against the defaults. Never throws and never rejects
 *  loudly: config files are hand-edited, and a malformed one must not break the
 *  widget. Status icons fall back individually; the spinner falls back as a whole,
 *  because half a frame sequence is not an animation. */
export function resolveTaskIcons(icons: TaskIconsConfig | undefined): TaskIcons {
  const glyph = (value: unknown, fallback: string) =>
    typeof value === "string" && value.length > 0 ? value : fallback;
  const spinner = icons?.spinner;
  return {
    completed: glyph(icons?.completed, DEFAULT_ICONS.completed),
    inProgress: glyph(icons?.inProgress, DEFAULT_ICONS.inProgress),
    pending: glyph(icons?.pending, DEFAULT_ICONS.pending),
    // Copied so a render site cannot mutate the defaults for every later caller.
    spinner: [...(isSpinner(spinner) ? spinner : DEFAULT_ICONS.spinner)],
  };
}
