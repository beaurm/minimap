# claude-nodes

A Claude Code mod that shows a high-level map of your project in a pane: its main sections and how they depend on each other.

> **Status:** the map is real and stays in sync with the repo. Highlighting the section Claude is working in comes next.

- **Terminal (`claude` CLI):** layered boxes joined by lines.
- **Claude Code Desktop:** an SVG node graph (hover a box for its description).
- **VS Code extension chat panel:** not supported yet, because the extension doesn't draw mod panes. Run `claude` in the VS Code terminal instead.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install project-map --marketplace beaurm/claude_nodes
```

Or from a shell:

```
claude plugin install project-map --marketplace beaurm/claude_nodes
```

Answer `y` to add the marketplace, then press Enter to pick the user scope. The pane opens at the start of each session; `/project-map` reopens it.

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `beaurm/claude_nodes`, then **Add plugin**.

## Usage

| Command | What it does | Uses tokens |
| --- | --- | --- |
| `/project-map` | Opens the pane | No |
| `/project-map init` | Asks Claude to explore the repo and write the map | Yes |
| `/project-map update` | Asks Claude to bring the map up to date, with what drifted | Yes |
| `/project-map reload` | Re-reads the map after you edit it by hand | No |

Only `init` and `update` call Claude, and only when you run them.

### The map file

The map lives in the repo at `.claude/project-map.json`, so it is shared with everyone who works on it. Commit it like any other file.

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
- No positions: the pane lays the graph out itself.

### Keeping it up to date

Because sections are path patterns, new files in existing folders belong to their section with no update needed. The mod also watches for drift, without calling Claude:

- a top-level folder no section covers,
- a file Claude writes that no section owns,
- a section whose folders no longer exist.

When something drifted, the pane says `Map out of date` and lists it. Run `/project-map update` when you want it fixed.

## Develop

Run Claude Code with the mod loaded straight from this folder:

```
claude --plugin-dir /path/to/claude_nodes
```

Check and test it:

```
claude plugin validate .
claude plugin test .
```

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | Mod manifest |
| `.claude-plugin/marketplace.json` | Makes this repo installable with `/plugin install` |
| `hooks/hooks.json` | Points to the hooks module |
| `hooks/register.tsx` | The mod: loading the map, the commands, drift tracking, drawing |
| `hooks/graph.ts` | Reading and checking the map file, path matching, drift checks |
| `hooks/layout.ts` | Placing any graph in layers |
| `types/index.d.ts` | The map's shape and the state the mod keeps |
| `tests/` | Unit tests for the helpers, and pane tests against a fake repo |
