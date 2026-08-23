# Customizing the task widget

How to make the task widget show what you care about: which tasks appear, in what order, and how many at a time.

Everything here is set in `tasks-config.json`. **Configuration is data, never code** — there is deliberately no executable config file, so nothing in a repository you clone can run on your machine.

- [Where config lives](#where-config-lives)
- [The display settings](#the-display-settings)
- [Sort presets](#sort-presets)
- [Writing your own sort order](#writing-your-own-sort-order)
- [Task glyphs](#task-glyphs)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)

## Where config lives

Two files, merged key by key, with the project file winning:

| Scope | Path | Use it for |
|-------|------|------------|
| **Global** | `<agent-dir>/tasks-config.json` — `~/.pi/agent/tasks-config.json` by default | Your personal defaults, everywhere |
| **Project** | `<workspace>/.pi/tasks-config.json` | Overrides for one repository |

The agent directory follows pi's configured agent path; set `PI_CODING_AGENT_DIR` to move it.

Merging is per key, not per file. With this global file:

```json
{ "sortOrder": "active", "maxVisible": 20 }
```

and this project file:

```json
{ "maxVisible": 5 }
```

that project sorts by `active` (from global) and shows 5 tasks (from project).

`/tasks` → Settings edits the **project** file only, and writes just the keys that differ from your global defaults — so changing one setting in a repo never freezes copies of your global preferences into it. Editing either file by hand works exactly the same; changes are picked up when the widget next renders.

## The display settings

| Setting | Values | Default | Behaviour |
|---------|--------|---------|-----------|
| `sortOrder` | a [preset](#sort-presets) or a [sort spec](#writing-your-own-sort-order) | `id` | The order tasks appear in |
| `collapseCompleted` | `true` / `false` | `false` | Replace completed tasks with a single `✔ N completed` line at the bottom. When off, they stay in the list, dimmed and struck through |
| `maxVisible` | `5`–`100` | `10` | Cap on task lines (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | Show every listed task regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | `bottom` | Which end the `… and N more` line collapses from |
| `glyphs` | a [glyph set](#task-glyphs) | `✔` / `◼` / `◻` + star spinner | The glyphs the widget is drawn with |

These compose in a fixed order, which is what makes combinations predictable:

1. **Sort** — `sortOrder` orders every task.
2. **Collapse** — if `collapseCompleted` is on, completed tasks leave the list and become one count line.
3. **Truncate** — `maxVisible` / `showAll` / `hiddenAt` apply to whatever is left.

So `collapseCompleted` and `maxVisible` are independent knobs: collapsing decides *what is in the list*, the visible limit decides *how much of that list you see*. With 28 completed and 12 open tasks, `collapseCompleted: true` plus `maxVisible: 10` gives you ten open tasks, an overflow line counting only the remaining open ones, and one line for the 28 finished.

The header line always counts **all** tasks, whatever the display settings do:

```
● 40 tasks (28 done, 1 in progress, 11 open)
  ✳ #29 Running tests…
  ◻ #30 Wire up config
  … and 9 more
  ✔ 28 completed
```

## Sort presets

| Preset | Order |
|--------|-------|
| `id` **(default)** | Creation order |
| `status` | completed → in-progress → pending, then by id |
| `active` | in-progress → pending → completed, then by id |
| `recent` | Most recently updated first |
| `oldest` | Least recently updated first |

`status` is **completed-first**, which is the reverse of the `TaskList` tool's pending-first order. It exists to pair with `hiddenAt: "top"`, which folds finished work away at the top of the widget. If you want active work at the top of the list instead, use `active`.

Presets are selectable from `/tasks` → Settings, so you never need to edit a file for these.

## Writing your own sort order

When no preset fits, `sortOrder` also accepts a **sort spec**: an ordered list of comparison keys. The first key decides the order; each later key is consulted only to break the previous one's ties.

```json
{
  "sortOrder": [
    { "field": "status", "rank": ["in_progress", "pending", "completed"] },
    { "field": "id" }
  ]
}
```

| Key | Values | Notes |
|-----|--------|-------|
| `field` | `id` / `status` / `updatedAt` | Required |
| `direction` | `asc` / `desc` | Default `asc`. Reverses this key only — `rank` included |
| `rank` | a list of task statuses | `status` only. Statuses left out sort last, tied with each other |

A few things that follow from the design:

- **Every preset is itself a spec.** The example above is exactly `"sortOrder": "active"` — a good starting point to copy and adjust.
- **Sorting is stable.** Tasks the spec cannot tell apart stay in creation order.
- **`updatedAt` is a millisecond timestamp.** Tasks touched in the same tick tie on it, and several tasks created in one batch will all share a value. End a spec with `{ "field": "id" }` whenever you want the tie-break to be deliberate rather than incidental.
- **`direction` is per key.** `{ "field": "status", "rank": [...], "direction": "desc" }` reverses that rank; it does not touch the keys after it. There is no global "reverse everything" switch, because reversing a whole order also flips its tie-breaks, which is almost never what you want.
- **A broken spec is not fatal.** Anything the extension doesn't recognise — an unknown field, a misspelled status, a stray string — falls back to `id` order instead of breaking the widget. See [Troubleshooting](#troubleshooting).

In `/tasks` → Settings, a spec shows up as a read-only `custom` value. The menu cannot edit one, and selecting a preset there **replaces** your spec — edit the JSON to get it back.

## Task glyphs

`glyphs` sets the characters the widget is drawn with. Every key is optional, and anything you leave out keeps its default — so this is both a complete example and the built-in set written out in full:

```json
{
  "glyphs": {
    "completed": "✔",
    "inProgress": "◼",
    "pending": "◻",
    "spinner": ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
    "completedSummary": "✔",
    "header": "●",
    "overflow": "…",
    "blocked": "›",
    "inputTokens": "↑",
    "outputTokens": "↓",
    "statsSeparator": "·",
    "trailingEllipsis": "…",
    "truncation": "..."
  }
}
```

Pasting that whole block changes nothing — it is there to copy and cut down to the keys you care about. `completedSummary` is the only entry that is not a fixed literal: left unset it follows `completed`, whatever you set that to.

Here is every glyph on screen at once, at its default. This is real widget output, with `maxVisible: 5`:

```
● 8 tasks (1 done, 2 in progress, 5 open)
  ✔ #1 Write the parser
  ✷ #2 Running the integration suite (agent ab12c)… (2m 49s · ↑ 4.1k ↓ 850)
  ◻ #3 Ship it › blocked by #2
  ◼ #4 Review the PR
  ◻ #5 Backlog item 5
    … and 3 more
```

| On that screen | Glyph |
|---|---|
| `●` opening the first line | `header` |
| `✔` on #1 | `completed` |
| `✷` on #2 — one frame of the animation | `spinner` |
| `…` closing #2's text | `trailingEllipsis` |
| `·` between `2m 49s` and the counts | `statsSeparator` |
| `↑` and `↓` before the counts | `inputTokens`, `outputTokens` |
| `◻` on #3 and #5 | `pending` |
| `›` before `blocked by #2` | `blocked` |
| `◼` on #4 | `inProgress` |
| `…` opening the last line | `overflow` |

Turn on `collapseCompleted` and #1 leaves the list for a count line of its own, marked with `completedSummary`:

```
● 8 tasks (1 done, 2 in progress, 5 open)
  ✷ #2 Running the integration suite (agent ab12c)… (2m 49s · ↑ 4.1k ↓ 850)
  ◻ #3 Ship it › blocked by #2
  ◼ #4 Review the PR
  ◻ #5 Backlog item 5
  ◻ #6 Backlog item 6
    … and 2 more
  ✔ 1 completed
```

The thirteenth, `truncation`, only shows up when a line is too wide for the terminal.

### The task glyphs

| Key | Default | Marks |
|-----|---------|-------|
| `completed` | `✔` | a finished task |
| `inProgress` | `◼` | a task in progress, but not being executed right now |
| `pending` | `◻` | a task not started yet |
| `spinner` | `✳ ✴ ✵ ✶ ✷ ✸ ✹ ✺ ✻ ✼ ✽` | the task an agent is actively working on, one frame per 150 ms |
| `completedSummary` | follows `completed` | the `N completed` line `collapseCompleted` puts in place of the rows |

`completed`, `inProgress` and `pending` are also used by `/tasks` → View all tasks. Everything else on this page is the widget only.

### The furniture

| Key | Default | Marks |
|-----|---------|-------|
| `header` | `●` | the widget's summary line |
| `overflow` | `…` | the `and N more` line standing in for rows the visible limit hid |
| `blocked` | `›` | introduces the `blocked by #1, #2` suffix |
| `inputTokens` | `↑` | precedes the input token count |
| `outputTokens` | `↓` | precedes the output token count |
| `statsSeparator` | `·` | sits between elapsed time and token counts |
| `trailingEllipsis` | `…` | closes the active row's text, marking the action as still running |
| `truncation` | `...` | marks a line clipped at the terminal's right edge |

### Things worth knowing

- **A glyph is a string, not a character.** `"[x]"`, `"⣾⣾"` and emoji with variation selectors all work, in the spinner and everywhere else. Control characters and bidirectional overrides are the exception — they would break the line or drive the terminal itself, so they fall back like any other bad value.
- **Keep every spinner frame the same display width.** Frames are not padded, so a sequence of uneven width shifts the rest of the line back and forth as it animates. The same goes for a status glyph against the spinner: give them equal width, or rows will jump when a task starts executing.
- **Nerd Font glyphs usually want a trailing space**, e.g. `"  "`, because terminals report them as one column wide while drawing them wider. Pad all four task glyphs the same way or they won't line up.
- **Glyphs merge one by one, not as a block.** A global `{ "glyphs": { "pending": "[ ]" } }` and a project `{ "glyphs": { "completed": "[x]" } }` give you both.
- **`completedSummary` follows `completed` unless you set it.** Change `completed` alone and the collapsed line follows along; set `completedSummary` to break them apart.
- **`truncation` is three ASCII dots, not `…`.** That is the terminal-clipping marker the widget has always used; set it to `"…"` if you want the widget consistent with its own `overflow` line.
- **Colors are not configurable.** Your glyph is drawn in its slot's existing color: green for completed, accent for in-progress, the spinner and the header, dim for the furniture, plain for pending.
- **A single space is how you hide one.** `" "` is a valid glyph and renders as spacing; an empty string is treated as unset and falls back to the default.
- **Bad values fall back quietly**, one glyph at a time — see [Troubleshooting](#troubleshooting).
- **Glyphs are config-file only.** `/tasks` → Settings cycles between fixed values, which free-form glyphs aren't.

## Recipes

**Active work first, finished work out of the way.** The most common ask:

```json
{ "sortOrder": "active", "collapseCompleted": true }
```

**Same idea, without editing a file.** From `/tasks` → Settings, set *Widget sort order* to `active` and *Collapse completed tasks* to `on`.

**Keep the widget short on a long backlog.** Newest activity first, five lines max:

```json
{ "sortOrder": "recent", "maxVisible": 5 }
```

**Fold completed work at the top, keep everything else visible.** The pairing `status` was designed for:

```json
{ "sortOrder": "status", "hiddenAt": "top", "maxVisible": 15 }
```

**In-progress first, then the most recently touched open work, oldest-created last.** Needs a spec:

```json
{
  "sortOrder": [
    { "field": "status", "rank": ["in_progress", "pending", "completed"] },
    { "field": "updatedAt", "direction": "desc" },
    { "field": "id" }
  ]
}
```

**Newest tasks first.** Reverse creation order:

```json
{ "sortOrder": [{ "field": "id", "direction": "desc" }] }
```

**An all-ASCII widget**, for a terminal or font that renders the default [glyphs](#task-glyphs) badly. Only the keys you name change:

```json
{
  "glyphs": {
    "completed": "[x]",
    "inProgress": "[>]",
    "pending": "[ ]",
    "spinner": ["|", "/", "-", "\\"],
    "blocked": "<-",
    "header": "*"
  }
}
```

## Troubleshooting

**The widget ignores my sort order.** A spec that fails validation silently falls back to `id` order. Check that `field` is one of `id` / `status` / `updatedAt`, that `direction` is `asc` or `desc` (not `ascending`), that every entry in `rank` is `pending` / `in_progress` / `completed`, and that `sortOrder` is a JSON *array* of key objects rather than a single object. An empty array falls back too.

**My settings aren't applying at all.** A `tasks-config.json` that isn't valid JSON is skipped whole, silently. Run it through a JSON validator — a trailing comma is the usual culprit. Remember the project file overrides the global one key by key.

**Two tasks are in the "wrong" order.** They probably tie on every key in your spec. Add `{ "field": "id" }` as the last key.

**The `/tasks` menu shows `custom` and I can't change it.** That's a sort spec in your config. Edit `tasks-config.json` to change it, or pick a preset in the menu to discard it.

**My glyphs are ignored.** Every glyph except `spinner` must be a *non-empty string*; anything else (a number, `null`, `""`, or a string carrying a control character or a bidirectional override) falls back to that one default and leaves the others alone. `spinner` must be a non-empty *array* of non-empty strings — a bare string like `"✳✴"`, an empty array, or one bad frame drops the whole sequence back to the default. Remember that `glyphs` merges one by one, so a glyph you didn't set in the project file may still be coming from your global one.

**Settings I change in one project show up in another.** Check your global `~/.pi/agent/tasks-config.json` — the settings menu only ever writes the project file, so a value that follows you around is coming from global.

---

See the [README](README.md) for everything else: task storage scopes, auto-cascade, auto-clear, and the tool reference.
