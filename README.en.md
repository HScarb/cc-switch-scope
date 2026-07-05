# cc-switch-scope

[中文](README.md) | **English**

Session-scoped Claude Code launcher (command: `ccscope`). It reads your Claude providers from [CC-Switch](https://github.com/farion1231/cc-switch) data, lets you pick one interactively (or by fuzzy match), then launches `claude` with that provider's settings — **each terminal session binds its own provider**, independently, without touching CC-Switch's global switch state.

## Why

CC-Switch switches providers globally (it rewrites `~/.claude/settings.json`), so every terminal shares the same provider at any given time. `ccscope` instead writes the provider's config to a temporary settings file and passes it via `claude --settings`, which means:

- Multiple terminals can run different providers simultaneously
- CC-Switch data is accessed strictly read-only — the GUI's state is never modified
- Common-config merge semantics match CC-Switch exactly
- Env keys leaking from `~/.claude/settings.json` (CC-Switch's currently active provider) are masked automatically — your session's model no longer follows the global switch state (v0.3.0+)

## Requirements

- Node.js ≥ 22.13.0 (SQLite is read via the built-in `node:sqlite`; zero npm runtime dependencies)
- [CC-Switch](https://github.com/farion1231/cc-switch) installed with at least one Claude provider configured
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`claude` available on PATH)

## Install

```bash
npm i -g cc-switch-scope
```

Or from source (for development):

```bash
git clone https://github.com/HScarb/cc-switch-scope.git
cd cc-switch-scope
npm link   # then use ccscope from anywhere
```

## Usage

```bash
ccscope                    # interactive menu (↑/↓/j/k to move, 1-9 to pick directly, Enter to confirm, Esc to cancel)
ccscope deep               # fuzzy match by provider name (case-insensitive; exact > prefix > current, menu on ambiguity)
ccscope 2                  # launch by index as shown in --list
ccscope deep -- -r         # everything after -- is passed through to claude verbatim
ccscope --list             # list providers (with current marker, base URL and data directory) without launching
ccscope --no-skip          # do not append --dangerously-skip-permissions
ccscope --version          # show version
ccscope --help             # show help
```

> **Note**: by default `--dangerously-skip-permissions` is appended to the `claude` invocation. Use `--no-skip` to disable that.

## Data sources

CC-Switch data is probed in this order (read-only):

1. **New SQLite database**: `<data-dir>/cc-switch.db` (preferred)
2. **Legacy config.json (v2)**: `<data-dir>/config.json` (fallback; v1 format is unsupported and reported explicitly)

Data directory resolution (matching CC-Switch):

1. `CC_SWITCH_DIR` environment variable
2. CC-Switch's custom data directory (`app_config_dir_override` in the Tauri Store `app_paths.json`, `~` prefix supported)
3. Default `~/.cc-switch` (on Windows, falls back to `HOME/.cc-switch` when the default directory has no database but that one does)

## Common-config merge

When a provider has "apply common config" enabled (`meta.commonConfigEnabled`), the common config is deep-merged into the provider config before launch, exactly matching CC-Switch's `json_deep_merge`: objects merge recursively per key, **common config wins on leaf conflicts**, arrays are replaced wholesale.

## Windows experience

- Before launching, the real target behind the `claude` command (`claude.exe` or a node script) is resolved and spawned directly, bypassing the cmd.exe batch shim — Ctrl+C exits cleanly with no "Terminate batch job (Y/N)?" prompt
- The temporary settings file is written with `0o600` permissions and cleaned up on exit (including Ctrl+C and error paths)

## Development

```bash
npm test                        # full test suite (node:test, zero deps)
node src/cli.js --list          # run locally (use CC_SWITCH_DIR=<dir> to isolate from real data)
```

## License

MIT
