# Budger

Budger is a local CLI that sends explicitly selected project files and a question to a configured headless AI command line tool. It uses ordinary child processes; it does not require MCP, a model SDK, or a Budger server.

## Requirements

Node.js 24.14 or newer. Bun 1.4.2 is supported for development and direct execution.

## Quick start

```sh
npm install
npm run build
node dist/cli/main.js init
# Review .budger/config.yaml and configure an executor that is installed and authenticated.
node dist/cli/main.js config validate
node dist/cli/main.js executors test codex       # Explicit model call; may consume quota.
node dist/cli/main.js bulk-read --question "Summarize the request flow" --paths src/server.ts --paths src/routes.ts
node dist/cli/main.js code-write --spec "Add a focused test" --reference tests/example.test.ts --target tests/new.test.ts
```

`init` creates the example config, authorizes its current effective contents in the user's local state directory, and installs project-local Claude Code skills and `PreToolUse` hooks. If the config changes, delegation stops until `init` is run again. Use `budger init --no-claude` to authorize without installing Claude Code files. `budger uninstall` removes only manifest-owned integration files that have not been edited.

The example uses Codex JSONL output. Executor configuration is declarative: command, argument vector, stdin or one `{prompt}` argument, timeouts, output limits, environment allowlist, and response selectors. Commands run with `shell: false`. Configure `fallback` explicitly if the same selected content may be sent to another executor.

## Using Claude Code as the main agent

`budger init` installs the compiled Budger runtime, two project-local Claude skills, and `PreToolUse` hooks in `.claude/settings.local.json`. It does not call a model. The example route delegates to Codex as a separate CLI, so install and authenticate that executor first, review `.budger/config.yaml`, then rerun `init` to authorize the exact config and finish installation. To use this checkout from another project, you can run `npm link` once after building and then use `budger` there.

In Claude Code, use its local tools for small, targeted searches and reads. The `/budger-bulk-reader` skill recommends `rg` for content search and `fd` for file discovery when installed, and reserves delegation for broad multi-file synthesis or large corpora where keeping all the source in Claude's context would be wasteful. The skill calls `budger bulk-read` directly and falls back to the project-installed runtime if `budger` is not on `PATH`. It returns the executor's answer to Claude for review. `/budger-code-writer` takes a specification, reference files, and a new target; Budger creates the file only if the target does not exist. Claude remains responsible for reviewing the answer or generated file.

The hooks inspect `Read` and a limited set of simple `Bash` reads. For a large unbounded read they deny that tool call and suggest the bulk-reader skill; Claude can then choose selected files and invoke the skill. Bounded reads such as `head -100` pass under the default 350-line threshold. Ambiguous shell commands pass through, and hook failures fail open. Set `BUDGER_DISABLE_HOOKS=1` to bypass these checks temporarily. Hooks are a context-saving aid, not a security boundary.

Use `budger doctor` to check local setup without a model call and `budger executors test codex` when you deliberately want to test the configured executor. The latter sends a small prompt and can consume quota. Use `budger stats` to see run counts, latency, reported usage/cost when configured, and separately labeled byte-based token estimates. `budger uninstall` removes unedited Budger-owned Claude files and hooks. These short commands assume `npm link` has added this checkout to your PATH; otherwise invoke `node /path/to/budger/dist/cli/main.js` with the same subcommand.

## Commands

- `budger run <route> --question TEXT --paths FILE [--paths FILE...]` runs a configured route.
- `budger bulk-read --question TEXT --paths FILE [--paths FILE...]` is the initial file analysis task.
- `budger code-write --spec TEXT --reference FILE [--reference FILE...] --target FILE` creates a new file. Existing targets are never replaced.
- `budger config show|validate` displays effective settings (environment values are hidden) or validates them.
- `budger doctor` reports local configuration and trust status without calling a model.
- `budger executors test NAME` performs an explicit minimal model call.
- `budger stats [--last 7d]` reports local run counts, latency, and available token estimates.

Budger exits with `0` on success, `1` for an operational or delegation failure, `2` for usage/config/trust validation, `124` for a final timeout, and `130` for cancellation. Claude hook decisions use their own contract and exit `0` for both pass-through and deny responses.

Selected paths must resolve to regular UTF-8 files within the project root. Prompts and outputs are bounded by route and executor limits. Source contents are serialized as untrusted data; prompt wording cannot guarantee protection from prompt injection. An executor is an external program, not a Budger sandbox, and may have its own tools, history, network access, and authentication.

Metrics are stored locally in SQLite and exclude source contents, prompts, responses, raw process output, environment values, and file paths. Token estimates use UTF-8 bytes divided by four, are labeled separately from executor-reported token counts, and do not establish billing savings. Reported costs are stored only when a JSON/JSONL response maps an amount field and a currency in the executor configuration; they are grouped by currency and are not verified invoices. Budger does not estimate money costs without a configured rate.

## Development

```sh
npm install
npm run format
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

Bun builds a self-contained ESM CLI for Node. Biome formats and lints the TypeScript source. Node's `node:sqlite` is used for local metrics. Before publishing, run `npm pack --dry-run` and verify the package under supported Node and Bun versions. Cross-platform process-tree termination and safe filesystem publication still require release CI on Windows, macOS, and Linux.

Configuration details and executor examples are in [docs/configuration.md](docs/configuration.md). The ownership and trust boundaries are described in [docs/architecture.md](docs/architecture.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
