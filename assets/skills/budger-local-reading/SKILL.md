---
name: budger-local-reading
description: Read project files with minimal context. Use when exploring code, locating definitions, or inspecting files; prefer rg and bounded Read calls.
---

When using local tools to inspect a project, minimize unrelated output and prefer these commands when available. If one is missing, use an available equivalent without announcing the fallback:

- Search content with `rg` instead of `grep`; use `rg --files` to locate paths and `rg -n` to find symbols, references, or matching lines. Find files by name with `fd` instead of `find`.
- Avoid `find -exec` and long `xargs` chains when a readable `fd -x` or `rg -l | xargs` pipeline works.
- Use `ast-grep` (`sg`) for structural or syntax-aware code searches and refactors when appropriate.
- Use `jq` to parse, filter, or transform JSON in pipelines, and `yq` for YAML or TOML.
- Use `gh` for GitHub pull requests, issues, reviews, CI status, and releases instead of scraping GitHub pages or calling its API directly.
- Use `hyperfine` when comparing command performance.
- For JavaScript or TypeScript projects, use `madge --circular` to check circular dependencies, `knip` to find dead code, and `jscpd` to find duplication when useful.
- Prefer targeted searches over dumping files to locate relevant code.
- When a path is known, use Claude Code's `Read` tool with `offset` and `limit` to inspect the relevant section. Read the whole file only when it is small or the task needs the whole file.
- For a few matching lines, use `rg -n -C <lines>` to include focused context. Avoid unbounded `cat`, `sed`, or similar output for large files.
- If a Bash read is necessary, keep it bounded, for example `sed -n '40,90p' path/to/file`. Do not combine unrelated reads into one command; that makes each read harder to assess and can produce oversized output.
- Use `/budger-bulk-reader` when synthesizing several known files would put too much source into Claude's context. Use `/budger-analyze` when the relevant paths are unknown and broad project exploration is needed.

Use the tools available in the current environment. Do not assume optional search tools exist. Follow the user's request when they explicitly need full-file output, and preserve exact source when editing or validating code.
