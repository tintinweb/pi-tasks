# Customizing the task widget

How to make the task widget show what you care about: which tasks appear, in what order, and how many at a time.

Everything here is set in `tasks-config.json`. **Configuration is data, never code** — there is deliberately no executable config file, so nothing in a repository you clone can run on your machine.

- [Where config lives](#where-config-lives)
- [The display settings](#the-display-settings)
- [Sort presets](#sort-presets)
- [Writing your own sort order](#writing-your-own-sort-order)
- [Task icons](#task-icons)
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
| `collapseCompleted` | `true` / `false` | `false` | Replace completed tasks with a single `✔ N completed` line at the bottom |
| `maxVisible` | `5`–`100` | `10` | Cap on task lines (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | Show every listed task regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | `bottom` | Which end the `… and N more` line collapses from |
| `icons` | an [icon set](#task-icons) | `✔` / `◼` / `◻` + star spinner | The glyphs tasks are marked with |

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

## Task icons

`icons` sets the glyphs tasks are marked with, in the widget and in `/tasks` → View all tasks. Every key is optional, and anything you leave out keeps its default:

```json
{
  "icons": {
    "completed": "✔",
    "inProgress": "◼",
    "pending": "◻",
    "spinner": ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"]
  }
}
```

| Key | Value | Marks |
|-----|-------|-------|
| `completed` | any non-empty string | Finished tasks, and the `✔ N completed` line when `collapseCompleted` is on |
| `inProgress` | any non-empty string | Tasks that are in progress but not being executed right now |
| `pending` | any non-empty string | Tasks not started yet |
| `spinner` | a non-empty list of non-empty strings | The task an agent is actively working on, animated one frame per 150 ms |

A few things worth knowing:

- **A frame is a string, not a character.** `["⣾⣾", "⣽⣽"]`, `["..", "··"]` and emoji with variation selectors are all valid frames. Only the glyphs are yours — the widget still cycles them at its own fixed rate.
- **Keep every frame the same display width.** Frames are not padded, so a sequence of uneven width shifts the rest of the line back and forth as it animates.
- **Icons merge per icon, not as a block.** A global `{ "icons": { "pending": "[ ]" } }` and a project `{ "icons": { "completed": "[x]" } }` give you both.
- **Colors are not configurable.** Your glyph is drawn in the slot's existing color: green for completed, accent for in-progress and the spinner, plain for pending.
- **Bad values fall back quietly**, one icon at a time — see [Troubleshooting](#troubleshooting).
- **Icons are config-file only.** `/tasks` → Settings cycles between fixed values, which free-form glyphs aren't.

An all-ASCII set, for a terminal or font that renders the defaults badly:

```json
{
  "icons": {
    "completed": "[x]",
    "inProgress": "[>]",
    "pending": "[ ]",
    "spinner": ["|", "/", "-", "\\"]
  }
}
```

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

## Troubleshooting

**The widget ignores my sort order.** A spec that fails validation silently falls back to `id` order. Check that `field` is one of `id` / `status` / `updatedAt`, that `direction` is `asc` or `desc` (not `ascending`), that every entry in `rank` is `pending` / `in_progress` / `completed`, and that `sortOrder` is a JSON *array* of key objects rather than a single object. An empty array falls back too.

**My settings aren't applying at all.** A `tasks-config.json` that isn't valid JSON is skipped whole, silently. Run it through a JSON validator — a trailing comma is the usual culprit. Remember the project file overrides the global one key by key.

**Two tasks are in the "wrong" order.** They probably tie on every key in your spec. Add `{ "field": "id" }` as the last key.

**The `/tasks` menu shows `custom` and I can't change it.** That's a sort spec in your config. Edit `tasks-config.json` to change it, or pick a preset in the menu to discard it.

**My icons are ignored.** Each of `completed` / `inProgress` / `pending` must be a *non-empty string*; anything else (a number, `null`, `""`) falls back to that one default and leaves the others alone. `spinner` must be a non-empty *array* of non-empty strings — a bare string like `"✳✴"`, an empty array, or one bad frame drops the whole sequence back to the default. Remember that `icons` merges per icon, so a glyph you didn't set in the project file may still be coming from your global one.

**Settings I change in one project show up in another.** Check your global `~/.pi/agent/tasks-config.json` — the settings menu only ever writes the project file, so a value that follows you around is coming from global.

---

See the [README](README.md) for everything else: task storage scopes, auto-cascade, auto-clear, and the tool reference.
