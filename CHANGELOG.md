## [0.10.3] - 2026-10-30

### Added

- The prompt says what `execute` replaces. The tool is the model's only tool, and the description now states it; one more
  guideline carries the idiom that stands in for the read/edit/write/bash tools: patch files through `pathlib` after
  asserting the exact text being replaced, and run commands with `subprocess.run([...])`.

### Changed

- The output cap marker names its cost. A cut channel used to end in `[... output truncated at 46080 chars ...]`:
  something was lost, with no size attached and no way back. The kernel now counts the characters it dropped past the cap,
  and the marker reports the cap, the count, and the two ways to get that text back — print the slice, or write it to a
  file and read it back. The per-line cut's marker got the same treatment.
- A cell error keeps both ends of its traceback. Python puts the frame that raised last, so the old head-only cut to ten
  stack lines deleted exactly the frame worth reading, and said nothing. The `ename: evalue` header still leads; past the
  budget the head keeps the call path, the tail keeps the raising frame, and a marker counts the lines between them. The
  total stays at eleven lines, and the formatting moved to `src/extension/error-format.ts` so its edge cases are testable
  without a live kernel.

### Fixed

- `docs/ARCHITECTURE.md` promised a 20-second abort grace; `PI_REPL_ABORT_GRACE_MS` is 5000. The same file's failure table
  implied the silence watchdog runs by default, and README called `PI_REPL_TIMEOUT_MS` a per-cell wall clock; it measures
  silence, and it is off by default, so a wedged cell runs until something cancels it. Both now match the code.

## [0.10.2] - 2026-10-30

### Removed (breaking)

- pi-fabric coexistence. The `fabric_exec` host probe and the `hostMode` / `toolsForHost` rules built on it are
  gone: the extension no longer senses which code-mode owns the prompt, it owns the model's tool surface.
  `session_start` collapses active tools to `execute` in one write, the engine always warms in the background,
  and the skills block plus the helper roster always join the prompt. The sidecar's lazy first-cell boot goes
  with the branch that needed it, and `docs/ARCHITECTURE.md` now documents one activation path instead of two.
- The host line in `/repl`. The command reports the interpreter, the process roles and their pids, the helpers
  and their directories, and the snapshot location — nothing else, because nothing is left to switch.

### Notes

- `PI_REPL_MAX_OUTPUT_CHARS` and the per-call `maxOutputChars` argument stay. They bound output for any caller
  with its own budget over nested results; only their prose named one such caller.

## [0.10.1] - 2026-10-30

### Added

- `PI_REPL_MAX_OUTPUT_CHARS` sets the per-cell output cap for the session (46,080 by default; values below 512
  are ignored rather than honoured, because such output is unreadable), and `execute` takes a `maxOutputChars`
  argument for a single call. The reason is nesting: a caller with its own output ceiling — a pi-fabric program
  bounding every nested result near 50,000 characters — can now spend a fraction of its budget on one cell
  instead of having one `print` consume all of it.

### Removed (breaking)

- The `--repl` flag, `PI_REPL_FORCE`, and the dormant/active split. The extension is always live and
  the host is detected rather than configured. `/repl on` and `/repl off` go with them — including the
  stock-loadout capture and its hardcoded fallback tool list, which could restore a set of tools
  missing whatever another extension had added. `/repl` stays, as read-only diagnostics.

### Changed

- Host-aware tool surface. Under pi-fabric, `fabric_exec` stays active and `execute` leaves the active
  set: a program reaches the persistent kernel as `extensions["pi-repl-py"].execute`, and the model's
  prompt carries exactly one code-mode. Under plain pi, active tools collapse to `execute` as before,
  and the bridge keeps `bash`/`read`/`edit`/`write` callable from cells.
- The engine boots lazily under a sidecar host — a session that never asks for Python starts no process.
- Windows interrupts and teardown. `SIGINT` is unsupported on Windows and jupyter_client 8 keeps the
  kernel pid on `km.provisioner.pid`, so an interrupt sends `CTRL+BREAK` to the process group (or the
  kernel pid) and teardown kills the tree with `taskkill /PID <root> /T /F`. A venv's `python.exe` is a
  launcher stub that re-execs, so killing one pid used to leave an orphan kernel holding COM handles —
  which is what locked DraftSight.

### Fixed

- Interpreter resolution on Windows: `Scripts/python.exe` instead of `bin/python3`, `py -3` probed,
  `where.exe` for PATH lookups, and a dependency probe that never executes environment code.
- `pyproject.toml` used an invalid PEP 508 marker (bare `os.name == "nt"`) that uv rejected, and
  omitted `psutil`, which ipykernel needs on every platform.
- Timeout units: `PI_REPL_TIMEOUT_MS` is now milliseconds; it was multiplied by 1000 before use.
- README and `docs/ARCHITECTURE.md` claimed `bash(...)`, `read(...)`, `edit(...)` and `write(...)` stay
  callable from inside a cell. They are not: commit 1708b75 retired that toolbox in favour of the helpers-only
  model, and nothing injects tool callables into the kernel namespace. Both now describe what is really there —
  plain Python (`subprocess.run`, `pathlib`, `!cmd`, `%%bash`).

## [0.9.0] - 2026-09-29

### Added

- `/repl on` and `/repl off`: switch the persistent Python REPL on and off mid-session. The
  `--repl` flag now only sets the starting mode. `/repl off` restores the tools that were
  active before repl took over (the built-ins if nothing was captured); the kernel is left
  running, so the namespace survives the round trip. Switching appends a tool delta to the
  transcript instead of rewriting the prompt, which on the newest Anthropic models keeps the
  cached prefix intact across the switch; other providers re-read the prefix once.

## [0.8.0] - 2026-09-04

### Changed

- The host no longer speaks the Jupyter wire protocol: one stdio pipe to `bridge.py` replaces the
  hand-rolled ZMTP 3.0 client, HMAC framing, and settle protocol (~1,100 lines deleted). The
  bridge owns `jupyter_client` + ipykernel; the host sends one JSON line per op and routes by id.
- Kernel death is pipe EOF plus an exit code — no socket-liveness guessing. The bridge also exits
  when the kernel dies, so the engine's rebuild path is driven by one truthful signal.
- Snapshot payloads never cross into the host: the bridge writes `namespace.snapshot` itself
  (atomic temp+rename) and replies with names and counts only.
- Snapshot cadence (name-diff gate, debounce, periodic refresh with the heavy-namespace
  stand-down) and the background revive's quiet-gap deferral moved into the bridge — a pickling
  snapshot or revive can never be sent ahead of a queued user cell by construction.
- Host deadlines collapse to three: boot (also bounds a wedged background revive), abort grace,
  and the optional silence watchdog.

### Added

- Snapshot format v4: cloudpickle serializes functions and classes by value, zlib-compressed.
  v1-v3 files remain restorable. The install venv gains `cloudpickle` (postinstall repairs
  existing venvs in place).

### Removed

- `src/engine/zmtp.ts` and `src/engine/session.ts` (the wire protocol, HMAC signing, and the
  settle-on-two-messages host machinery — the settle guarantee moved into the bridge).

## [0.7.1] - 2026-09-04

### Changed

- tightened contract

## [0.7.0] - 2026-09-04

### Added

- The helper roster follows the session's working directory, so the model is told exactly what the kernel booted with; failures surface as a marker on the first cell, and all-good boots stay silent.
- Each helper preloads in its own cell, so one broken file can no longer abort the rest.
- The prompt side honors PI_HELPERS_DIR / PI_HELPERS_GLOBAL_DIR exactly like the kernel loader.
- A /fork'd conversation inherits its parent's namespace: the parent's last snapshot is copied into the fork on first start, restored, and announced with a dedicated fork toast.
- Periodic snapshot refresh (`snapshot.periodMs`, default 2 minutes, 0 disables) bounds the loss window for same-name mutations; namespaces whose last snapshot exceeded 8 MiB stand down.
- Value payloads are zlib-compressed (version 3 snapshot format); v1 and v2 snapshots remain restorable.

### Changed

- The model-facing execute prompt: edits anchor the exact lines before replacing, prior state is framed as amortizing over re-deriving, and the truncation marker names its exact size.

### Fixed

- Kernel replies are HMAC-verified before routing; unsigned or forged traffic is now dropped.
- A failed snapshot no longer disables all future snapshots: the name-diff gate advances only on a persisted write.
- Bindings skipped at save time (oversized) are named in the resume notice alongside restore-time failures.
- Pending replies are type-gated, so a wrong-type message on the same parent id cannot settle a probe.
- Kernel recovery from a deleted cwd is covered by a test.

### Removed

- The prose paragraph from the static tool guidelines (restored to the pre-feature wording); comments from prompt.ts and tool-meta.ts.

## [0.6.14] - 2026-09-01

### Changed

- Snapshot recovery runs in the background and never delays the first tool call; the
  `<repl_engine_reset>` notice lands on the first cell after the restore completes.
- Mid-session rebuilds restore the last snapshot before the triggering cell.
- A restore that never completes is killed after `PI_REPL_BOOT_TIMEOUT_MS` (default 90s)
  and marked skipped, reported as "wedged while reviving; skipped".

### Fixed

- Sessions can no longer bleed into each other: the engine is bound to its conversation,
  and a different conversation's acquire tears the old one down instead of reusing it.
- State dirs are keyed `<project-slug>__<conversation>`; legacy dirs migrate on the owning
  conversation's next start, and the orphan sweep recognizes both formats, so deleting a
  conversation removes its snapshots.

## [0.6.13] - 2026-09-01

### Fixed

- A kernel boot that wedges (for example after an npm update swaps the venv under a live kernel, or a snapshot value that never finishes unpickling) no longer hangs the first cell forever: the boot is bounded by `PI_REPL_BOOT_TIMEOUT_MS` (default 90s), the wedged kernel is killed, and the session retries once with the snapshot deliberately skipped, announcing exactly that.
- Pure-traceback error cells no longer render a bogus "no output" line beneath the traceback in the expanded tool view, and the expanded panel always ends with a blank cushion row instead of text flush against the edge.

### Changed

- The prompt's edit guideline drops "a small unique anchor"; anchored replacements are the documented-brittle edit mode in notebook harnesses.

## [0.6.12] - 2026-08-27

### Changed

- Cells run with `store_history` off, so IPython's `In`/`Out` retention can no longer pin result objects and grow long sessions (same workload: 400+ MB to 180 MB, flat).
- Snapshot dirs now die with their conversations: a state dir whose conversation file exists in no project session root is swept on the next start, so deleting a conversation deletes its snapshots.
- A kernel rebuild or resumed session fires a terse PI notification instead of only the in-cell reset marker; the model still gets the named revive/loss block.

## [0.6.11] - 2026-08-27

### Changed

- Resumed conversations announce their restore on the first cell: revived and lost names are named, so the agent re-verifies instead of walking into a namespace it may not have.
- Snapshots now capture cell-defined functions and classes by source and re-execute them on restore; entries are capped per binding and in total, writes are atomic, and old session snapshot directories are pruned.
- Expanded cells render highlighted code from a cache instead of re-highlighting every frame; per-cell wrap caches are bounded against resize churn.

## [0.6.10] - 2026-08-26

### Changed

- The execute tool contract now frames the workspace as a Jupyter notebook with a shared environment: names persist for the notebook's life, reuse over recompute, and reverify after resets.

## [0.6.9] - 2026-08-25

### Changed

- Tightened the execute tool contract: one narrow-the-output rule, reference what the shell already holds instead of re-fetching, helper bullets nested under a header.
- Expanding a cell shows the full output (bounded by the 45K cap) instead of a 50-line head/tail window.
- Cell headers preview Python file idioms (write/read/mkdir/delete/append/rename) for pathlib/open/shutil/os calls.
- Rendering is incremental: fast plain wrap, streamed output re-wraps only the delta, dirty-counter cache keys — no more hitches streaming, expanding, or typing over big cells.
- The debounced snapshot waits for kernel quiet instead of queuing ahead of the next cell, so heavy namespaces no longer stall it.

### Removed

- The preview layer's TypeScript/Bun/tools detectors from the earlier foundation — they only previewed code this Python evaluator can't run.

# Changelog

## [0.6.8] - 2026-08-21

### Added

- Helpers can live in a project's `.pi/helpers/` directory, discovered by walking up from the working directory to the git root; the global `~/.pi/agent/pi-repl/helpers/` still applies to every project, and a project helper shadows a same-named global one.

## [0.6.7] - 2026-08-21

### Changed

- Rebuilt the execute tool prompt in pi's native shape: a single mechanical description, one-line snippet, flat guideline bullets.
- Output cap lowered to 45K so an accidental large dump is truncated early, with a marker, instead of carrying into context.

### Fixed

- Aborting a running cell no longer kills and restarts the kernel when the cell is slow to raise KeyboardInterrupt (for example C-bound work that only yields at a checkpoint): the kernel is given time to settle, and only a cell that genuinely never stops is killed as a last-resort cap.
- Helper lines render as single bullets instead of a doubled list marker in the tool prompt.

## [0.6.3] - 2026-08-21

### Changed

- Reworked the execute print guidance to frame output as a context cost the model carries forward.

## [0.6.2] - 2026-08-21

### Fixed

- An unresponsive or dead kernel no longer hangs the execution queue: a cell that swallows KeyboardInterrupt is killed after a grace window, and an unexpected kernel exit is detected so the next cell rebuilds.
- Wrapped code lines keep their source indentation on continuation rows.
- Bare Python identifiers now get a syntax color instead of rendering flat.
- Running-state spinner switched to a dot scroller at 120ms.

## [0.6.1] - 2026-08-20

### Changed

- Tightened the execute tool prompt: actionable voice and reduced section count.

## [0.6.0] - 2026-08-20

### Added

- Get-up-to-speed acclimation and output-format guidance to the execute tool prompt.
- Snapshot only fires when the namespace name-set changed, so unchanged cells skip the full pickling cost.

### Changed
- Rebuilt the execute tool prompt around result-proven output (fewer, denser sections).
- Restored shell/subprocess/timeout as its own section.

## [0.5.0] - 2026-08-19

### Added

- Ctrl+O expands a live cell stream as soon as the call starts (the tool body is established at call time, mirroring the host's bash tool) instead of waiting for the result.

### Changed

- Execute tool prompt retooled around working in the workspace and proving work by returned result.
- Web helper reads return a bounded preview/window by default; dropped the redundant markdown alias.
- Added define-once-reuse guidance and aligned the opener with the result-proven framing.

## [0.4.0] - 2026-08-18

### Added

- Skills are advertised in repl mode instead of being dropped by pi's read-gated prompt.

### Changed

- Reworked the execute tool description and snippet.

## [0.3.0] - 2026-08-17

### Added

- Kernel now always runs in the install venv (`~/.pi/agent/pi-repl/venv`), so project venvs without ipykernel can no longer shadow it.

### Fixed

- Startup no longer blocks render on the kernel revive; the engine warms up in the background.
- Kernel fallback to the host cwd when the requested session directory no longer exists, instead of dying with a missing-cwd error.

### Removed

- The `[pi-repl-restore]` startup popup; the namespace still revives silently in the background.

## [0.2.8] - 2026-08-17

### Changed

- Tightened the execute tool prompt to frame helpers as preloaded objects the model calls directly, avoiding `import` of a similarly-named package.
- Added a third-party-packages section to the helpers documentation (install into the repl venv).
- Added a helper-creation example skill (design-first, iterate with the user before writing code).
- Added an example `example/` link in the README.

## [0.2.7] - 2026-08-14

### Changed

- Capped per-line output as well as per-channel, so a single oversized line cannot consume the whole output budget.
- Tightened execute prompt guidance around targeted search, surgical edits, and minimal output.

## [0.2.6] - 2026-08-13

### Changed

- Tightened execute prompt guidance for targeted searches, surgical edits, and repository-safe changes.

## [0.2.5] - 2026-08-13

### Changed

- Clarified the README, architecture, design, helper, and Termux documentation.
- Added a provider-backed web helper example.

## [0.2.4] - 2026-08-13

### Added

- Documented the Termux/Android installation path, including the patched `psutil` build required when no compatible PyPI wheel is available.

## [0.2.3] - 2026-08-12

### Changed

- Reworked the REPL prompt around persistent workspace use, iterative execution, timeout discipline, and recovery after engine resets.

## [0.2.2] - 2026-08-12

### Fixed

- Installation now verifies that `ipykernel` is importable, repairs incomplete environments, and fails clearly when the evaluator cannot be built.

## [0.2.1] - 2026-08-12

### Changed

- Clarified that helpers may provide functions, classes, constants, imports, or reusable complex operations.
- Renamed `docs/how-to-functions.md` to `docs/helpers.md`.

## [0.2.0] - 2026-08-12

### Added

- Added timeout guidance for shell commands that may hang.

### Changed

- Simplified the REPL around native Python and a persistent `ipykernel` workspace.
- Reworked helper loading, prompt guidance, and installation configuration.
- Removed the shipped shell/edit helpers in favor of native Python workflows.

### Fixed

- Improved kernel startup, timeout, abort, snapshot, restore, output-limit, and recovery behavior.

## [0.1.1] - 2026-08-09

### Added

- Added helper discovery, evaluator environment setup, and `--repl` activation.

### Changed

- Reframed execution as a persistent notebook-style Python workspace.

### Fixed

- Improved timeout handling, process cleanup, output limits, and kernel recovery.

---

See docs/ARCHITECTURE.md for the design and `docs/` for how-to material.

