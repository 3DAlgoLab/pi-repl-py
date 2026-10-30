# pi-repl-py

A [pi](https://pi.dev) extension that gives the agent one `execute` tool backed by a **persistent Python kernel**. Variables, imports, dataframes, open files and live object handles stay alive for the whole session. Only output comes back to the conversation.

```
✓ repl · data = load_json("records.json")
✓ repl · avg = sum(v["score"] for v in data)/len(data)
✓ repl · print("mean score:", round(avg, 2))    · mean score: 41.7
```

`data` is still there in cell three. Nothing was re-read and nothing re-derived from earlier output.

## Why

pi's code-mode is stateless per call: every invocation starts a fresh interpreter. For throwaway computation that is free. It stops being free the moment the work has state that is expensive or impossible to rebuild — a loaded dataset, a database transaction, a live COM connection.

Driving DraftSight over `win32com` is the founding case. Re-acquiring that connection per call costs an interpreter start, `import win32com.client`, typelib dispatch warm-up and a fresh COM apartment — roughly 0.3–1.5 s, paid once per tool call, so a drawing built over 50 turns pays it 50 times. Worse, a stateless kernel can never hold a pywin32 event sink or hand a wrapper object back in without re-resolving it. One kernel that stays up removes that tax entirely.

It is **not** an interactive shell: the agent sends batches of Python to a kernel that stays alive for the session.

## Install

```bash
pi install git:github.com/3DAlgoLab/pi-repl-py
```

The postinstall builds the Python venv the kernel needs at `~/.pi/agent/pi-repl/venv`. If `python3` or the network is missing it says so plainly instead of half-building. On a clone, run `just setup` (`just setup --project` builds a project-local `.venv` instead). Termux needs `psutil` built from source: [docs/termux.md](docs/termux.md).

## Use

Start `pi` and send Python. There is no flag and nothing to switch on.

At `session_start` the active tools collapse to `execute` alone, so the prompt carries exactly one code-mode. Nothing is missing inside a cell: shell and files are plain Python there (`subprocess.run`, `pathlib`, and ipython's `!cmd` and `%%bash`). There are no `bash(...)`/`read(...)` wrapper callables — that toolbox was removed in favour of helpers.

A cell that raises reports the traceback and the kernel keeps going. `/repl` prints diagnostics: process roles and pids, the interpreter chosen, the helpers loaded and where they came from, the snapshot location. It changes nothing.

## Layout

One folder, no config file:

```
~/.pi/agent/pi-repl/
  venv/       the interpreter + ipykernel
  helpers/    global helpers, every *.py is preloaded
  state/      per-session namespace snapshots
```

A **helper** is a `.py` file exec'd into every kernel, so its functions, classes and constants are simply available in the cell. Put one in `<project>/.pi/helpers/` (project wins) or the global directory above; `/reload` or a new session picks it up. Each helper's `helper_description` is shown to the model verbatim, and the contract is in [docs/helpers.md](docs/helpers.md). Global helpers ship empty — shell and file IO are already plain Python (`!cmd`, `%%bash`, `subprocess.run`, `pathlib`).

## Interrupts, measured

Aborting a cell (Ctrl-C, or the harness cancelling the call) sends an interrupt, which takes effect at the next Python bytecode boundary and cannot enter a blocking call. Measured on Windows, Python 3.14: a loop of `time.sleep(0.05)` dies ~0.2 s after the signal; one `time.sleep(3)` finishes its 3 s first. A cell parked inside a single C call — a hung COM/RPC, a socket read — never regains a boundary, so after `PI_REPL_ABORT_GRACE_MS` (default 5000) the kernel is killed and the result says `KernelReaped`: every live handle it held died with it, and recovery comes from the last snapshot, not from memory. The engine survives its kernel — the next cell boots a fresh one. The rule that follows: write cells as many short calls. Forty COM calls are interruptible between each; one `Rebuild()` is not interruptible at all.

## Interpreter and knobs

Resolution lives in `src/engine/python-locate.ts`; a candidate that cannot import `ipykernel` and `cloudpickle` is skipped rather than booted, so a bare repo `.venv` can never shadow a working one. The winner is exported to the kernel as `PI_PYTHON`, so a helper or sibling skill installs into the interpreter that is actually running instead of guessing: `$PI_REPL_PYTHON` → `$PI_PYTHON` → project `.venv` (when `PI_PROJECT_VENV=1`, or if it already has the deps) → the managed venv → any `python` / `python3` / `py -3` on PATH that can import them.

| Variable | Effect |
| --- | --- |
| `PI_PYTHON`, `PI_REPL_PYTHON` | pin the interpreter, trusted without probing |
| `PI_PROJECT_VENV=1` | the project's `.venv` wins; its `pyvenv.cfg` authorises that project's `PYTHONPATH`, nothing else |
| `PI_HELPERS_GLOBAL_DIR` | change the global helpers directory (default `~/.pi/agent/pi-repl/helpers`) |
| `PI_HELPERS_DIR` | use exactly one helpers directory and skip the normal project-then-global walk |
| `PI_REPL_TIMEOUT_MS` | per-cell wall clock, 0 (off) by default |
| `PI_REPL_ABORT_GRACE_MS` | how long an aborted cell gets before the kernel is reaped (5000) |
| `PI_REPL_MAX_OUTPUT_CHARS` | per-cell output cap, 46,080 by default; 4,096 per line, cuts marked. A caller with one budget shared across many results wants this lower; one call can override it with `maxOutputChars` |

## It is not

- A sandbox: the kernel runs with your permissions.
- A subagent framework: no `repl.run` API, use `subprocess.run`.
- A tool rack: one `execute` tool, functions inside it.

## More

- [docs/design.md](docs/design.md) — why this design
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — venv, kernel, process tree, tool surface
- [docs/helpers.md](docs/helpers.md) — writing helpers
- [example/](example/) — helpers and skills to copy

## License

MIT. See [LICENSE](LICENSE).
