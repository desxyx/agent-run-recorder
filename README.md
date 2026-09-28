# Agent Run Recorder

A local command-line recorder for noninteractive AI agent runs. It saves the exact stdout and stderr bytes, a common ordered JSONL event view, observed stream or process boundaries, and a SHA-256 receipt. Version 0.1 is a technical preview.

## Requirements

- Node.js 20 or later
- For `capture codex`: an authenticated, directly spawnable Codex executable with `exec --json`
- For `capture claude`: an installed, authenticated Claude Code CLI with `--print --verbose --output-format stream-json`

There are no npm dependencies. On Windows, the Codex adapter searches for `codex.exe` first in `PATH`, then in `%USERPROFILE%\.vscode\extensions\openai.chatgpt-*-win32-x64\bin\windows-x86_64\codex.exe`. It does not launch a `codex.cmd` shim or pass the prompt through `cmd.exe`. A global npm install that exposes only a `.cmd` shim is not automatically supported; that layout has not been tested here. Use `--exe <path-to-codex.exe>` to select a directly spawnable binary. Windows `.cmd`, `.bat`, and `.ps1` overrides are rejected.

For `capture codex`, set `--cwd` to a Git repository or another directory Codex trusts. The adapter does not pass `--skip-git-repo-check`; Codex may reject a plain untrusted directory and the recorder will save that failure as `PARTIAL`.

## Quick start

```sh
node bin/agent-recorder.js ingest generic-jsonl --input example.jsonl --out runs
node bin/agent-recorder.js capture codex --prompt-file prompt.txt --out runs
node bin/agent-recorder.js capture claude --prompt-file prompt.txt --out runs
node bin/agent-recorder.js summary runs/RUN_ID
node bin/agent-recorder.js verify runs/RUN_ID
node bin/agent-recorder.js verify runs/RUN_ID --expected-root SHA256
```

Omit `--input` or `--prompt-file` to read stdin. `capture` also accepts `--cwd DIRECTORY`; this is passed as a process working directory, never placed in a shell command. The capture commands enforce their structured-output flags and do not forward arbitrary client options.

Each completed command prints a single-line `ROOT_SHA256=<digest>` receipt. Save that line **outside** the run directory, for example in your own notes or commit message. The recorder does not modify Git. A local `verify` without a separately saved digest reports only `INTERNALLY_CONSISTENT_ONLY`; `--expected-root` can report `UNCHANGED_RELATIVE_TO_EXPECTED_ROOT`. A coordinated rewrite of the run files can recompute the local root and pass an unanchored check.

## Generic JSONL contract

Each nonempty line is one newline-terminated UTF-8 JSON object. The `type` property can be `session`, `assistant_output`, `tool_call`, `tool_result`, or `error`. Other values and malformed lines become `unknown` events. Every source record is retained in `stdout.bin` and copied into the private event payload. The recorder adds `recorder-observed` start and input-end events; source lines carry `source-reported`, line numbers, and ordered event ordinals.

Generic ingest observes only the input stream. It records `exit_code: null` and never claims to know the producer's process result. An empty stream or a stream ending after a newline is `COMPLETE` **as an input stream only**; an unterminated final line is `PARTIAL`. EOF does not prove the producer exited successfully or reported every action.

```jsonl
{"type":"session","id":"example"}
{"type":"assistant_output","text":"Hello"}
{"type":"tool_call","name":"lookup","arguments":{"key":"x"}}
{"type":"tool_result","value":"found"}
```

The Codex and Claude adapters map their visible structured events into these common kinds. Unknown source events remain in the raw file and are counted as unknown; their source-controlled names are never copied into `summary`.

## Run files and recovery

| File | Purpose |
|---|---|
| `stdout.bin` | Exact source stdout bytes |
| `stderr.bin` | Exact source stderr bytes |
| `events.jsonl` | Ordered common event view with source payloads |
| `manifest.json` | Adapter/version, times, exit, completeness, coverage, hashes, counts |
| `root.sha256` | SHA-256 of exact manifest bytes |

`verify` checks all artifact hashes and sizes, regenerates the normalized event sequence from raw stdout, and checks the local root. It does not prove that the source told the truth or exposed every action.

A child CLI that exits unsuccessfully or is interrupted while the recorder survives yields a finalized `PARTIAL` run with its observed exit or signal. If the recorder itself stops before writing a manifest, `verify` reports `UNSEALED_PARTIAL`. Run `node bin/agent-recorder.js seal-partial RUN` to hash the surviving bytes and create a new `PARTIAL` baseline. That recovery records no original end time, cannot infer a missing tail, and cannot protect bytes that were changed before sealing.

## Privacy

Run directories are private local data. They may contain prompts, tool arguments, tokens, paths, and errors. Do not commit or share them without an independent review. `summary` emits only allowed counts, enums, times, hashes, and fixed coverage labels; it excludes arbitrary source text. The test suite scans the entire summary output for synthetic secrets and checks that a deliberately leaking output fails the scanner. This does not make raw artifacts safe to publish.

## Scope

This preview records structured, noninteractive runs only. It does not capture interactive terminal sessions, browser actions, hidden model state, workspace snapshots, or actions the source does not report. macOS parser portability can be checked with fixtures; live macOS capture requires a real macOS run before making a support claim.

Run `node --test` for the local test suite.
