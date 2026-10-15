# claude-nodes

A Claude Code mod that keeps a high-level map of your project in a side pane: its main sections, how they depend on each other, and, live, which section Claude is working in.

```text
○ Idle · last reading hooks/layout.ts · Layout

                    ╭────────────────╮
                    │    Pane UI     │
                    │register.tsx +1 │
                    ╰────────────────╯
                           │ │ │
           ┌───────────────┘ │ └───────────────┐
           ▼                 ▼                 ▼
╭────────────────╮  ╭────────────────╮  ╭────────────────╮
│     Layout     │  │    Activity    │  │  Plugin Meta   │
│   layout.ts    │  │  activity.ts   │  │ .claude-plugin │
╰────────────────╯  ╰────────────────╯  ╰────────────────╯
```

Where it draws:

- **Terminal (`claude` CLI):** boxes joined by lines in a docked pane. Works in the terminal of any editor.
- **Claude Code Desktop:** an SVG node graph. Hover a box for its description and how often Claude touched it.
- **VS Code extension chat panel:** not supported yet, because the extension doesn't draw mod panes. Run `claude` in the VS Code terminal instead.

## Install

At the prompt of a terminal Claude Code session:

```text
/plugin install project-map --marketplace beaurm/claude_nodes
```

Or from a shell:

```sh
claude plugin install project-map --marketplace beaurm/claude_nodes
```

Answer `y` to add the marketplace, then press Enter to pick the user scope. The pane opens at the start of each session.

- **Following Claude:** on a map taller than the pane, the pane scrolls to the section Claude moves to. It only moves when that section is off screen, so you can scroll around yourself (focus the pane with ctrl+x tab) without it fighting you.
- **Closing:** the pane's `x` closes it, and it stays closed in later sessions too. While it's closed, a line under the prompt says `pane closed · /project-map to reopen`. `/project-map` brings it back, and from then on it opens with each session again.

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `beaurm/claude_nodes`, then **Add plugin**.

## Usage

The first time, in your project:

```text
/project-map init
```

Claude explores the repo and writes `project-map.json`. Commit it so everyone shares the same map.

| Command | What it does | Uses tokens |
| --- | --- | --- |
| `/project-map` | Opens the pane | No |
| `/project-map init` | Asks Claude to explore the repo and write the map | Yes |
| `/project-map update` | Asks Claude to bring the map up to date, given what drifted | Yes |
| `/project-map reload` | Re-reads the map after you edit it by hand | No |

Only `init` and `update` call Claude, and only when you run them.

### Live tracking

Every time Claude reads, edits or writes a file, or runs a command that names paths, the mod finds the sections that own those files. A command reading files across several sections lights all of them, and so do calls Claude runs in parallel:

- **Working now:** a double border (`═`), and the box shows the file instead of its folder. The lines into and out of it turn orange. The pane's top line says what Claude is doing (`● Editing src/api/routes.ts · API`) and lists the section's direct links.
- **Touched this turn:** an orange border. When the turn ends, the pane switches to `○ Idle · last …` and keeps the trail until the next turn starts.
- **Subagents:** each one at work gets its own status line, and its section lights up too, until its own turn ends.
- The header counts which sections were touched most this session.

Tracking adds no model calls and never blocks a tool call. If it fails, the call goes through untouched.

### The map file

`project-map.json` at the repo root:

```json
{
  "version": 1,
  "sections": [
    { "id": "api", "label": "API", "description": "HTTP routes", "paths": ["src/api/**"] },
    { "id": "db", "label": "Database", "paths": ["src/db/**", "migrations"] }
  ],
  "edges": [["api", "db"]]
}
```

- `paths` are glob patterns from the repo root: `*` within a folder, `**` at any depth, and a plain folder name means everything in it. When several sections match a file, the most specific pattern wins.
- `edges` are `[from, to]` pairs meaning "from depends on to".
- No positions: the pane lays the graph out itself. To keep the picture readable it leaves out an edge that a longer path already implies (with `a → b → c`, it doesn't draw `a → c`); the active section's links line lists them all.

It is a plain, visible file on purpose. Claude Code treats files under `.claude/` and hidden files at the repo root as sensitive, and would ask for approval on every `init` or `update` (or refuse outright in headless runs).

### Keeping it up to date

Because sections are path patterns, new files in existing folders belong to their section with no update needed. The mod also watches for drift, without calling Claude:

- a top-level folder no section covers,
- a file Claude writes that no section owns,
- a section whose folders no longer exist.

When something drifted, the pane says `Map out of date` and lists it. Run `/project-map update` when you want it fixed.

## Develop

Run Claude Code with the mod loaded straight from this folder:

```sh
claude --plugin-dir /path/to/claude_nodes
```

Check and test it:

```sh
claude plugin validate .
claude plugin test .
```

One catch when trying `init` or `update` on this repo itself: Claude Code protects a loaded plugin's own files, so with `--plugin-dir .` Claude can't write `project-map.json` here. Load a copy of the plugin from another folder instead.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | Mod manifest |
| `.claude-plugin/marketplace.json` | Makes this repo installable with `/plugin install` |
| `hooks/hooks.json` | Points to the hooks module |
| `hooks/register.tsx` | The hooks: loading the map, commands, tracking calls, the pane's open/close |
| `hooks/tracking.ts` | Live tracking as pure steps: calls and turns in, what to highlight out |
| `hooks/activity.ts` | Which files and sections a tool call touches |
| `hooks/graph.ts` | Reading and checking the map file, path matching, drift checks |
| `hooks/prompts.ts` | What `init` and `update` ask Claude |
| `hooks/layout.ts` | Placing any graph in layers |
| `hooks/connectors.ts` | Routing the lines between layers |
| `hooks/terminal.tsx` | The pane's drawing: header, footer, and the terminal's map |
| `hooks/svg.ts` | The map as an SVG (Desktop) |
| `hooks/boxes.ts` | What each box shows: its file or folder, and the highlight |
| `types/index.d.ts` | The map's shape and the state the mod keeps |
| `tests/` | Unit tests for the helpers, and pane tests against a fake repo |
| `project-map.json` | This repo's own map, made with `/project-map init` |
