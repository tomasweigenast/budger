# Configuration

Budger reads YAML from the nearest project `.budger/config.yaml` and the user config directory. On macOS/Linux the global file is `${XDG_CONFIG_HOME:-~/.config}/budger/config.yaml`; on Windows it is `%APPDATA%/budger/config.yaml`. The nearest ancestor with a project config is the project root; without one, Budger uses the Git root or current directory.

Built-in values are applied first, then global config, then project config. Executors and routes combine by name, with a project definition replacing the entire global definition of that name. Hook and metrics sections combine by field. Arrays are replaced. Unknown keys and invalid route or executor references are rejected.

Run `budger init` to create the example, inspect the effective executable names, arguments, environment variable names, and route destinations, and authorize the effective config fingerprint. Any config change invalidates authorization. `budger config show` hides literal environment values; `budger config validate` does not execute commands. Keep secrets out of command arguments because operating systems may expose process arguments to local process inspection.

## Executors

An executor describes one process. `command` is started directly with `shell: false`; `args` is an array of arguments. `input.mode` is `stdin` or `argument`. Argument input requires exactly one argument whose complete value is `{prompt}` and a positive `maxBytes` limit. Stdin is the default and preferred mode.

The only substitutions are `{projectRoot}` and `{tempDir}` in `args` and `cwd`. Budger does not evaluate shell expressions or expand arbitrary variables. `env.inherit` names the parent environment variables passed to the child. `env.values` sets literal values. Budger adds `BUDGER_ACTIVE=1` and `NO_COLOR=1` to child processes.

`timeoutMs`, `maxStdoutBytes`, and `maxStderrBytes` must be positive integers. The executor receives separate stdin/stdout/stderr streams. Timeout, cancellation, and output overflow terminate the process tree before a fallback begins. Windows `.cmd` and `.bat` files are not launched through a shell; configure the real executable or an explicit runtime wrapper.

## Routes and file limits

Routes name a primary executor, optional fallback executor names, instructions, and limits. Fallbacks are empty by default and run once each, in order. Each executor or response failure, including output-limit failures, can proceed to the next configured fallback after the prior process tree has terminated. Cancellation stops routing. File validation and code-write publication happen outside the fallback loop.

`budger run NAME --question TEXT --paths FILE` delegates the selected UTF-8 files and question using the route's instructions. Repeat `--paths` for additional files. Paths must resolve inside the project root. Budger rejects non-files, invalid UTF-8, NUL bytes, symlink escapes, and files or prompts that exceed configured limits. File contents are JSON-serialized as untrusted data. Prompt text cannot prevent prompt injection.

The main per-route limits are `maxFiles`, `maxFileBytes`, `maxInputBytes`, and `maxResultBytes`. Executor stdout/stderr limits apply independently. The CLI does not save selected content or prompt history.

## Response parsing

`response.format` supports `text`, `json`, and `jsonl`. JSON Pointer values use RFC 6901-style `/` segments, with `~1` for `/` and `~0` for `~`. `text.pointer` selects response text; `text.match` filters JSON/JSONL records by exact scalar equality; `text.take` is `last` or `concat`.

Optional `success.match` and `failure.match` selectors identify turn completion and failure events. `errorPointer` identifies an error field. A missing configured success event, a matched failure, invalid JSON, empty response, nonzero exit, or invalid selected usage/cost field fails the attempt. Stderr is never interpreted as the response.

`usage.fields` can select `inputTokens`, `outputTokens`, `cachedInputTokens`, and `reasoningOutputTokens`. Missing values stay unknown. A `cost` selector can map one reported amount and a fixed ISO currency code. Budger does not infer prices or call tool-reported cost an invoice.

## Example: Gemini CLI

Gemini supports prompt arguments, stdin input, and JSON output. A small executor configuration can use:

```yaml
executors:
  gemini:
    command: gemini
    args:
      - --prompt
      - "Answer the request supplied on stdin."
      - --output-format
      - json
      - --approval-mode
      - plan
    input: { mode: stdin }
    response:
      format: json
      text: { pointer: /response }
      errorPointer: /error
```

Gemini also appends stdin to its prompt. Its `plan` approval mode does not mean all tools are disabled; do not treat it as a sandbox. Configure a process recipe only after verifying the installed CLI's behavior and authentication.
