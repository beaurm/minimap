# claude-nodes: project-map

A Claude Code mod that shows a high-level map of your project in a pane, with the section Claude is working in highlighted live.

> **Status: demo.** The graph and the activity are hardcoded dummy data. Nothing reads your repo or tracks Claude's tool calls yet.

- **Terminal (`claude` CLI):** layered boxes, with the active section highlighted.
- **Claude Code Desktop:** an SVG node graph, with the active section pulsing.
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
| `hooks/register.tsx` | The mod: the pane, the `/project-map` command, the demo data |
| `types/index.d.ts` | Types for the state the mod keeps (the active step) |
| `tests/pane.test.ts` | Checks that the pane draws on terminal and desktop |
