# minimap

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

minimap runs in the terminal (`claude` CLI), including the built-in terminal of any editor. The VS Code extension is not supported.

## Install

At the prompt of a terminal Claude Code session:

```text
/plugin install minimap --marketplace beaurm/minimap
```

Or from a shell:

```sh
claude plugin install minimap --marketplace beaurm/minimap
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

## Usage

The first time, in your project:

```text
/minimap init
```

Claude explores the repo and writes `minimap.json`. You can commit it so teammates who use minimap share the same map.

| Action | What it does | Uses tokens |
| --- | --- | --- |
| Live tracking | Lights up the sections Claude reads, edits or runs commands on, as it works | No |
| Drift detection | Notices folders and files the map doesn't cover, and sections whose folders are gone | No |
| `/minimap` | Opens the pane | No |
| `/minimap init` | Asks Claude to explore the repo and write the map | Yes |
| `/minimap update` | Asks Claude to bring the map up to date, given what drifted | Yes |
| `/minimap reload` | Re-reads the map right away (it also reloads by itself at the start and end of each turn when the file changed) | No |

Only `init` and `update` call Claude, and only when you run them. Everything else, tracking included, runs locally without any model calls.

### The pane

- **Opening:** the pane opens at the start of each session when the terminal is wide enough (Claude Code needs about 144 columns to open a pane by itself). In a narrower terminal, a line under the prompt says `/minimap to open the map`.
- **Following Claude:** on a map taller than the pane, the pane scrolls to the section Claude moves to. It only moves when that section is off screen.
- **Closing:** the `x` closes the pane, and it stays closed, even in new sessions, until you run `/minimap`. While it's closed, a reminder under the prompt shows that command.

### Live tracking

Every time Claude reads, edits or writes a file, or runs a command that names paths, the mod finds the sections that own those files. A command reading files across several sections lights all of them, and so do calls Claude runs in parallel:

- **Working now:** a double border (`═`), and the box shows the file instead of its folder. The lines into and out of it turn orange. The pane's top line says what Claude is doing (`● Editing src/api/routes.ts · API`) and lists the section's direct links.
- **Touched this turn:** an orange border. When the turn ends, the pane switches to `○ Idle · last …` and keeps the trail until the next turn starts.
- **Subagents:** each one at work gets its own status line, and its section lights up too, until its own turn ends.
- The header counts which sections were touched most this session.

Tracking adds no model calls and never blocks a tool call. If it fails, the call goes through untouched.

### The map file

`minimap.json` at the repo root:

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

When something drifted, the pane says `Map out of date` and lists it. Run `/minimap update` when you want it fixed.

## What minimap can access

minimap runs as a hook on Claude's tool calls, so here is exactly what it does:

- **Reads, never writes.** It reads `minimap.json`, lists your repo's top-level folders, and checks that your sections' folders still exist. It never writes or changes your files; only Claude writes `minimap.json`, when you run `init` or `update`.
- **Watches, never interferes.** For each Read, Edit, Write, LSP or shell call, it looks at the file path or command to find the section. It never changes or blocks a call, and if tracking fails, the call goes through untouched.
- **No network, no programs.** It makes no network requests and runs no commands of its own.
- **Tokens only when you ask.** It never calls the model by itself. Only `/minimap init` and `/minimap update` send Claude a prompt.
- **Keeps almost nothing.** Tracking lives in the session and is gone when it ends. The one thing kept across sessions is whether you closed the pane.

You can check this yourself: `claude plugin validate .` in this repo lists every call the plugin makes.

## Limitations

- **Start Claude Code at the repo root.** minimap looks for `minimap.json` in the folder where the session starts, and reads paths from there. Started in a subfolder (or in one package of a monorepo), it finds no map.
- **Plugin API changes.** minimap is built on Claude Code's plugin API, which is still in early access and may change between releases. A Claude Code update can break it. It is tested with Claude Code 2.1.299; older versions may not draw the pane.
- **PowerShell on Windows.** PowerShell doesn't set `TERM`, and without it Claude Code doesn't draw the pane properly or let you click it. Set it before starting Claude Code:
  ```powershell
  $env:TERM = "xterm-256color"
  claude
  ```
  To make it stick, add the first line to your PowerShell profile (`notepad $PROFILE`). Bash terminals on Windows (Git Bash, WSL) work as is.
- **Wide characters in labels.** Box widths count characters, so labels with wide characters (Chinese, Japanese, Korean, emoji) can misalign their boxes.

## Uninstall

```sh
claude plugin uninstall minimap
```

That's all it takes: minimap stops running and its stored settings are removed.

Installing also registered this repo as a marketplace (where Claude Code finds the plugin). That entry does nothing on its own, but if you want no trace left:

```sh
claude plugin marketplace remove minimap
```

The `minimap.json` files in your repos are ordinary files: delete them if you no longer want them. To switch minimap off without uninstalling, use `claude plugin disable minimap` (and `enable` to bring it back).

## Develop

Run Claude Code with the mod loaded straight from this folder:

```sh
claude --plugin-dir /path/to/minimap
```

Check and test it:

```sh
claude plugin validate .
claude plugin test .
```

One catch when trying `init` or `update` on this repo itself: Claude Code protects a loaded plugin's own files, so with `--plugin-dir .` Claude can't write `minimap.json` here. Load a copy of the plugin from another folder instead.

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
| `hooks/boxes.ts` | What each box shows: its file or folder, and the highlight |
| `types/index.d.ts` | The map's shape and the state the mod keeps |
| `tests/` | Unit tests for the helpers, and pane tests against a fake repo |
