# Architecture

```text
CLI ── config + local trust ── task validation ── route/fallback
                                  │                    │
                                  └── selected files    ▼
                                                generic process executor
                                                        │
                                      response parser + usage/cost fields
                                                        │
                                    SQLite run/attempt metrics ── CLI output
```

`core` owns configuration, route resolution, limits, and local configuration authorization. `tasks` validates selected files, builds the untrusted-data prompt, and handles safe file publication for `code-write`. `executors` owns child process creation, stdio, termination, response parsing, and usage mapping. `hooks` reads Claude Code events and applies conservative `Read`/`Bash` checks. `integration` installs project-local skills and hooks and tracks owned files. `metrics` stores only run metadata and selected reported/estimated measures. `cli` owns parsing, output streams, and exit codes.

The executor has no task or Claude-specific behavior. Adding a route is configuration; adding a new effect requires task code. There is no public provider interface, dynamic plugin loader, conversation store, or MCP server.

## Trust and process limits

The effective config fingerprint is stored in the user's local state directory. An untrusted or changed config disables hooks and blocks delegation until `budger init` authorizes it. Child process execution is not a sandbox: configured programs can have their own tools, network access, history, authentication, and data access. Budger forwards only explicitly selected files in its prompt, but cannot constrain an arbitrary program's other behavior.

The Claude hooks are optional reading optimizations. They fail open on invalid input, config, file access, or timeout. The Bash recognizer handles a limited set of literal simple commands and passes pipes, shell operators, substitutions, globs, variables, unknown flags, and ambiguous commands through untouched. It does not execute commands to inspect them.

## Filesystem behavior

Source files are resolved before reading and checked against the project root. Reading is bounded while streaming. `code-write` requires an existing parent directory, writes a same-directory temporary file, then publishes with a no-replacement hard link. If the filesystem cannot provide that operation, Budger returns an error and leaves the target unchanged.

Claude integration updates only exact Budger hook entries and files whose manifest hash still matches. Settings writes use a same-directory atomic rename and verify that the settings file did not change while installation was being prepared. Uninstall preserves edited or unowned artifacts.
