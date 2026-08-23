/**
 * task-glyphs.ts — The glyphs the task widget and the /tasks menu are drawn with.
 *
 * Glyphs are pure data — there is deliberately no executable config file, because
 * `.pi/` lives inside cloned repositories. A hand-edited config must never break
 * the widget, so anything unrecognised falls back to the built-in glyph.
 */

/** A fully resolved glyph set — what the render sites consume. */
export interface TaskGlyphs {
  /** Completed task rows, in the widget and the /tasks list. */
  completed: string;
  /** In-progress rows that are not being executed right now. */
  inProgress: string;
  /** Rows not started yet. */
  pending: string;
  /** Frames for the actively-executing row, one per widget tick. */
  spinner: readonly string[];
  /** The `N completed` line that `collapseCompleted` puts in place of the rows. */
  completedSummary: string;
  /** The bullet on the widget's summary line. */
  header: string;
  /** The `and N more` line standing in for rows the visible limit hid. */
  overflow: string;
  /** Introduces the `blocked by #1, #2` suffix on a blocked row. */
  blocked: string;
  /** Precedes the input token count on the active row. */
  inputTokens: string;
  /** Precedes the output token count on the active row. */
  outputTokens: string;
  /** Between elapsed time and token counts: `(2m 49s · ↑ 4.1k)`. */
  statsSeparator: string;
  /** Closes the active row's text, marking the action as still running. */
  trailingEllipsis: string;
  /** Marks a line clipped at the terminal's right edge. */
  truncation: string;
}

/** Glyphs as written in `tasks-config.json`: every resolved glyph, all optional.
 *  Derived rather than restated, so a glyph cannot be added to one list and
 *  forgotten in the other. `spinner` is respelled because the resolved form is
 *  readonly while JSON hands us a plain array. */
export type TaskGlyphsConfig = Partial<Omit<TaskGlyphs, "spinner">> & { spinner?: string[] };

/** Every glyph's built-in default. `completedSummary` is deliberately absent: it has
 *  no literal of its own and inherits whatever `completed` resolves to.
 *
 *  The spinner walks the dingbat block. Claude Code's own spinner is a shorter
 *  mirrored sequence (`· ✢ ✳ ✶ ✻ ✽` and its reverse, with a ghostty variant);
 *  this one is deliberately ours.
 *
 *  `truncation` is three ASCII dots rather than `…` because that is pi-tui's own
 *  default, and the widget has always clipped with it. */
const DEFAULT_GLYPHS: Omit<TaskGlyphs, "completedSummary"> = {
  completed: "✔",
  inProgress: "◼",
  pending: "◻",
  spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
  header: "●",
  overflow: "…",
  blocked: "›",
  inputTokens: "↑",
  outputTokens: "↓",
  statsSeparator: "·",
  trailingEllipsis: "…",
  truncation: "...",
};

/** Control characters would break the widget's one-line-per-entry contract or steer
 *  the terminal itself (a glyph carrying `ESC ]0;…` retitles the window), and bidi
 *  overrides reorder the line around the glyph. A `tasks-config.json` that arrived
 *  with a cloned repository must not be able to do either. */
const UNSAFE_GLYPH = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** A glyph may be any non-empty string, not just one character — `[x]`, `⣾⣾` and an
 *  emoji with a variation selector are all valid, as glyphs and as spinner frames. */
const isGlyph = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !UNSAFE_GLYPH.test(value);

function isSpinner(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isGlyph);
}

/** Resolve configured glyphs against the defaults. Never throws and never rejects
 *  loudly: config files are hand-edited, and a malformed one must not break the
 *  widget. Each glyph falls back on its own; the spinner falls back as a whole,
 *  because half a frame sequence is not an animation. */
export function resolveTaskGlyphs(glyphs: TaskGlyphsConfig | undefined): TaskGlyphs {
  const glyph = (value: unknown, fallback: string) => isGlyph(value) ? value : fallback;
  const completed = glyph(glyphs?.completed, DEFAULT_GLYPHS.completed);
  const spinner = glyphs?.spinner;
  return {
    completed,
    inProgress: glyph(glyphs?.inProgress, DEFAULT_GLYPHS.inProgress),
    pending: glyph(glyphs?.pending, DEFAULT_GLYPHS.pending),
    spinner: isSpinner(spinner) ? spinner : DEFAULT_GLYPHS.spinner,
    // Falls back to the resolved `completed` rather than to a literal of its own:
    // a config that sets only `completed` should not leave the line that stands in
    // for those rows marked with a different glyph.
    completedSummary: glyph(glyphs?.completedSummary, completed),
    header: glyph(glyphs?.header, DEFAULT_GLYPHS.header),
    overflow: glyph(glyphs?.overflow, DEFAULT_GLYPHS.overflow),
    blocked: glyph(glyphs?.blocked, DEFAULT_GLYPHS.blocked),
    inputTokens: glyph(glyphs?.inputTokens, DEFAULT_GLYPHS.inputTokens),
    outputTokens: glyph(glyphs?.outputTokens, DEFAULT_GLYPHS.outputTokens),
    statsSeparator: glyph(glyphs?.statsSeparator, DEFAULT_GLYPHS.statsSeparator),
    trailingEllipsis: glyph(glyphs?.trailingEllipsis, DEFAULT_GLYPHS.trailingEllipsis),
    truncation: glyph(glyphs?.truncation, DEFAULT_GLYPHS.truncation),
  };
}
