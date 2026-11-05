# Tollgate

Tollgate is a Claude Code plugin that checks a plugin repository before you submit it to Anthropic's plugin directory, and fills in the submission form for you. The plugin lives in [plugin/](plugin/); its README, [plugin/README.md](plugin/README.md), describes what it checks, what it runs, reads and writes, and how to try it.

## Install

In Claude Code:

```
/plugin marketplace add Ablation-Lab/tollgate
/plugin install tollgate@tollgate
```

Or copy `plugin/skills/submission-check` into `~/.claude/skills/` to use it as a personal skill (then it's `/submission-check`).

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | the plugin folder (Plugin path `plugin` in the directory portal) |
| `plugin/skills/submission-check/` | the skill: `SKILL.md`, `scripts/check.mjs` and its modules, reference notes |
| `samples/` | the sample maker and its expected results (outside the plugin folder, so its planted problems never ship) |
| `.claude-plugin/marketplace.json` | lets Claude Code install the plugin from this repo |
| `test/` | tests, run with `node --test` (not part of the plugin) |
| `scripts/privacy-check.sh`, `.githooks/` | the maintainer's pre-commit privacy check; the plugin never runs it |
| `.plugin-check-allow.json` | findings allowed when Tollgate checks itself, each with its reason |

## Development

```
node --test
node plugin/skills/submission-check/scripts/check.mjs . --no-validate
```

The second line checks this repository with itself. Keep `plugin/README.md` and `SKILL.md` in step when either changes, and keep the versions in `plugin.json` and `marketplace.json` equal.

MIT licence. An independent project, not made or endorsed by Anthropic.
