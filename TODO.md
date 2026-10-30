# TODO — pi-repl-py: Windows + reliability

Design note (2026-10-30, later superseded): 0.10.1 shipped pi-fabric coexistence — the extension sensed
`fabric_exec` in the tool surface and stepped aside as a durable-state **sidecar** instead of owning the
model's tool surface. That host probe is now **removed**: the extension is always live and `execute` is
always the model's tool surface. C2 and C5 below are reverted; C1, C3, C4, C6, C7 stand — none of them
depended on which host was running.

Order: A (Windows) → B (reliability) → C (coexistence). A before C because a coexistence design for an
extension that cannot start on Windows is decoration.

---

## A — Windows support

- [x] **A1 single interpreter resolver** (`src/engine/python-locate.ts`)
  - pin (`PI_REPL_PYTHON` → `PI_PYTHON`, the shared contract with draftsight-com) → project `.venv` →
    managed venv → PATH. Non-pin candidates must **probe** (`importlib.util.find_spec`) for
    `ipykernel` + `cloudpickle`, so a bare repo venv can never shadow the good one.
  - `Scripts/python.exe` on Windows, `bin/python3` on POSIX. Probe caches `sys.executable`.
  - Acceptance: on Windows the resolver returns `Scripts/python.exe`; a `.venv` without ipykernel is skipped.
- [x] **A2 `scripts/setup-venv.mjs`**: platform-aware venv path, `execFileSync` (no shell quoting),
  `python3` → `python` → `py -3`, prefer `uv` when present (uv venvs have no pip).
  Acceptance: `npm install` succeeds on Windows and produces an importable venv.
- [x] **A3 process-tree kill**: `process.kill(-pid)` is POSIX-only. Windows → `taskkill /PID <pid> /T /F`;
  `detached` only off Windows, `windowsHide: true` everywhere.
  Acceptance **measured**: a boot → cell → `session_shutdown` cycle leaves the `tasklist` python.exe count
  unchanged (2 → 2). **A leaked kernel keeps DraftSight open and locked** — the worst failure mode in the repo.
- [x] **A4 pywin32 in the managed venv on Windows** (`pywin32>=306; sys_platform=='win32'` shape, mirroring
  draftsight-com's `pyproject.toml:9`). Decision I made — reversible if you want the COM deps project-local only.
- [x] **A5 export the winner as `PI_PYTHON`** into the kernel env, so sibling skills install into the
  interpreter the kernel actually runs. Today `pi-repl-py` uses `~/.pi/agent/pi-repl/venv` while
  draftsight-com probes `~/.pi/.venv`/`VIRTUAL_ENV` — neither reads the other, which is the exact silent
  failure draftsight-com's own README warns about.
- [x] **A6 tests/paths platform-aware**: `test/engine.integration.test.ts:50` hardcodes `$HOME/.pi/…/venv/bin/python3`.

## B — reliability (prerequisite: COM calls are exactly what wedges a kernel)

- [x] **B1 reject pending requests on bridge exit.** `child.on("exit")` settles the active cell but leaves
  `this.pending` untouched → an in-flight `snapshot` never settles → `dispose()` hangs → `session_shutdown`
  hangs → the orphan keeps its COM handles.
- [x] **B2 route a bridge `error` carrying the active cell's id.** `bridge.py:484` emits
  `{"type":"error","id":<exec id>}`; `handleLine` only checks `pending`, so the cell never settles and — with
  `PI_REPL_TIMEOUT_MS` defaulting to 0 (watchdog off) — hangs forever and the whole queue queues behind it.
- [x] **B3 bound the shutdown snapshot flush.** `dispose()` awaits `snapshotState()` with `.catch` but no deadline.
- [x] **B4 tests** for B1/B2 via a fake bridge — `test/units.test.ts` "bridge pipe routing" drives
  `KernelClient`'s private constructor with a fake `send`/`handleLine`: id-routed stream+result, an `error`
  event rejecting a pending request, an error reply carrying the exec id, unparseable lines dropped.

## C — coexistence work (C2 + C5 reverted; C1, C3, C4, C6, C7 stand)

- [x] **C1 remove the flag**: no `--repl`, no dormancy throw, no `registerFlag`, no `PI_REPL_FORCE`. The tool
  registers on every `session_start`; the engine warms in the background under takeover and boots lazily under a
  sidecar host.
- [x] ~~**C2 host detection instead of a mode option**~~ — **reverted.** `hostMode`/`toolsForHost` are gone
  along with the `fabric_exec` probe they were built around. `session_start` now always collapses the tool
  surface to `execute` in one write, and the engine always warms in the background.
- [x] **C3 delete the restore hazard**: `/repl on|off`, the stock-loadout capture, `restoredTools`, and
  `FALLBACK_TOOLS = ["read","bash","edit","write"]` are gone — that fallback would silently drop `fabric_exec`.
  `/repl` is now read-only diagnostics.
- [x] **C4 nested-output budget**: `PI_REPL_MAX_OUTPUT_CHARS` sets the session cap (falls back to the 46,080
  default for junk or values under 512, which would produce output nobody can read), and a call can override it
  with the new `maxOutputChars` tool argument. Any caller with its own ceiling over nested results sets it once
  rather than per cell. Unit-tested for the resolution rule,
  integration-tested for both the session default and the per-call override winning.
- [x] **C7 an abort landing during cold boot is swallowed**: fixed. The abort listener and the grace timer
  are armed *before* `await this.start()`, and a cell withdrawn during boot is cancelled at the submission point
  instead of running: it returns `aborted` with the boot included in `durationMs`, and the warm kernel serves the
  next cell. Test: cold engine, `x = 1; time.sleep(5)` aborted at 250 ms → settles in 2.1 s, and a later
  `execute("x")` still raises `NameError`, proving the cell never executed.
- [x] **C6 abort-reap was terminal**: fixed. When the abort grace expires the engine drops to `"idle"`, records
  `reapRecovery`, and clears `startPromise`/`helperReport`; the **next** cell boots a fresh kernel and takes the
  existing `restoreWithReap()` path, snapshot revived ahead of it. One wedged DraftSight RPC plus one Ctrl-C no
  longer ends the session's Python. The reap test now also asserts the following cell is served.
- [x] **C5 prompt scoping** — simplified with C2 gone: the skills block and the helper append apply on every
  `before_agent_start`; there is no host branch to skip them for.

## D — verification

- [x] D1 gate green on Windows: `tsc -p .` and `tsc -p tsconfig.test.json` clean, `biome check .` clean,
  `bun test test/units.test.ts test/preview-core.test.ts` → **105 pass / 0 fail**.
  Two prerequisites found first: Bun was not installed on this machine at all (the entire gate is bun), and the
  repo had no `.gitattributes` while the checkout ran `core.autocrlf=true`, so biome's format gate could never pass
  against CRLF worktree files. Added `.gitattributes` (`* text=auto eol=lf`).
- [x] D2 robustness tests green on this machine (python 3.14.4): `bun test test/units.test.ts
  test/preview-core.test.ts` → **105 pass / 0 fail**; `bun test test/engine.integration.test.ts` →
  **36 pass / 0 fail** in 132 s, including the two abort tests (C6 next-cell-after-reap, C7 cold-boot abort) and the
  output-cap test.
- [x] D3 the managed venv is real on Windows, not theoretical: `~/.pi/agent/pi-repl/venv` resolves as
  `managed-venv`, and a spec probe in it reports python **3.14.4** with `ipykernel`, `jupyter_client`,
  `cloudpickle`, `psutil`, `win32com`, `win32api` all importable — so A4 (pywin32 on Windows) and the
  `psutil` fix are both satisfied by the tree `scripts/setup-venv.mjs` built.
- [ ] D4 live smoke: DraftSight running → `connect()`, push geometry, restart the kernel, reconnect via a
      helper, confirm no orphan `python.exe`.

## Known, deliberately deferred

- Rename `execute` → `python`: **not** a Fabric conflict (`extensions.execute` works). The argument is
  legibility — under Fabric, extension tools reach the prompt as a **names-only roster**
  (configuration.md:491) — plus this repo's own `getActiveTools().filter(n => n !== "execute")` assumes any
  `execute` in the loadout is its own. Your call.
- `colorBareIdentifiers` reset bug: pi emits `39` resets, so bare-identifier painting is dead in production
  and the unit test cannot see it.
- `just setup` installs only `ipykernel` → `just integration` fails on a fresh venv (needs cloudpickle).
- No CI config at all; `justfile` recipes are POSIX-only; knip reports dead exports.
- Interrupt semantics are now measured rather than guessed (see Log): the 20 s `ABORT_GRACE_MS` guess is a 5 s
  default, and a reaped kernel is reported as `KernelReaped` so the model learns its COM proxies died. What is
  *not* solvable here: no interrupt enters a blocked C call, so a DraftSight call that hangs inside COM is only
  reclaimable by killing the kernel, leaving DraftSight mid-transaction. That is Windows signalling, not this
  extension — the mitigation is writing cells as many short COM calls so they stay interruptible.

## Log

- 2026-10-30 plan agreed; nothing implemented yet. Working tree clean.
- 2026-10-30 **A1-A6, B1-B3 implemented** (checkboxes flipped; details in the item text). Typecheck clean, biome clean.
  A3's `tasklist` proof is still owed — the code path (`killProcessTree`: `taskkill /PID /T /F`, `detached`
  off Windows, `windowsHide` everywhere) is in place, but nobody has counted orphan `python.exe` after a session.
- 2026-10-30 **Windows interrupt path measured.** jupyter_client 8.x removed `interrupt()` from
  `BlockingKernelClient` and its control-channel request is a no-op there, so `bridge.py` interrupts through the
  kernel's Win32 event handle (`proc.win32_interrupt_event`, handed to the kernel as `JPY_INTERRUPT_EVENT` and
  waited on by ipykernel's `ParentPollerWindows`). Measured 6/6 at **~0.30 s** to settle a busy cell.
- 2026-10-30 **Watchdog honesty.** A cell the interrupt *did* cut is now reported `aborted` carrying the bridge's
  own `KeyboardInterrupt` (ipykernel reports an interrupted exec as an *error*, not status `aborted`); only a cell
  that outran the interrupt and answered normally stays a `Timeout`. Silence-kill grace 2 s → 4 s.
- 2026-10-30 **Test toolchain on Windows.** No Bun on this machine, so `bun test`/`bunx` — the entire gate —
  cannot run. `.smoke/buntap/` is a `bun:test` → Node shim (sequential tests, bun's 5 s default timeout,
  warn-don't-abort on unhandled rejections, `.js`→`.ts` import rewrite). Measured here: units 86/86,
  preview-core 16/16, integration 30/33. Decide: commit the shim as `test/shim` + a `just test-node` recipe
  (repo then has a gate on Windows) or just install Bun.
- 2026-10-30 **Stale test config found.** Six integration tests passed `snapshot.debounceMs`, a key the engine
  never had (policy is name-diff gate + `period_ms`): silently ignored, so those tests configured nothing they
  thought they were configuring. Removed. `slowFactor()` also used `require()` in an ESM test — bun-only, breaks
  under Node. Both fixed.
- 2026-10-30 **Measuring now:** aborting a cell running a *single long blocking call* (`time.sleep(60)`) took
  21 s in the integration suite — the 20 s abort grace expired and the kernel was killed, not interrupted — while
  a loop of short sleeps is cut in ~0.3 s. If the probe confirms it, the conclusion is blunt: **an interrupt
  cannot cut a hung COM call on Windows**, which is the founding use case, and `ABORT_GRACE_MS = 20 s` was
  then only a slower route to the same kill. Probe `.smoke/latprobe3.py`, run in the managed venv
  (python 3.14.4), one interrupt fired 0.5 s into the cell: loop of 0.05 s sleeps settled at **0.71 s**, single
  `time.sleep(3)` at **3.19 s**, no-interrupt control at **3.01 s**. SIGINT is raised at the cell's next bytecode
  boundary; it never enters a blocking call.
- 2026-10-30 **Implemented the timeout/abort findings.** `ABORT_GRACE_MS` 20 s → `DEFAULT_ABORT_GRACE_MS` 5 s and
  per-engine via `env.PI_REPL_ABORT_GRACE_MS` (same idiom as `PI_REPL_TIMEOUT_MS`): when the grace works it costs
  milliseconds, and when it cannot work 20 s was just a slower route to the same kill. A reaped cell now returns
  `status: "aborted"` with `error.name = "KernelReaped"` naming what died (COM proxies, open files, connections)
  and that namespace recovery comes from the last snapshot — bare `aborted` implied the handles survived, and the
  model would have gone on calling a dead proxy. `ExecuteOptions.signal` and `bridge.py:_interrupt_windows`
  docstrings corrected: both claimed the interrupt lands "inside the running cell".
- 2026-10-30 **Test tree never typechecked.** `tsconfig.json` includes only `index.ts` and `src/**/*.ts`, so
  `just types` stayed green while `test/units.test.ts` carried three TS2339 errors: the `routedKernel` seam type
  lacked `snapshot`/`listNames`/`restore`, i.e. the fake bridge was out of date with the router these tests
  exercise. Added `tsconfig.test.json` (extends the base, relaxes unused-locals, declares `@types/bun` — never a
  dependency before), fixed the seam, wired both projects into `npm run typecheck` and `just types`. Green.
- 2026-10-30 **Integration tests rewritten to the real contract.** The silence-window test now expects `aborted`
  plus a kernel that still serves; the abort/namespace test uses a **yielding** cell (that is exactly why it
  previously burned the whole grace and then failed the namespace check); a new test pins the uncuttable case with
  `PI_REPL_ABORT_GRACE_MS=1500` and asserts `KernelReaped`. Six tests were also passing a `snapshot.debounceMs`
  key the engine never had — silently ignored, so they configured nothing they thought they configured.
- 2026-10-30 **Live reap probe** (`.smoke/reapprobe.mjs`, warm engine, grace 1500 ms): abort at +0.80 s → settled
  at **2.48 s** with `KernelReaped`; the next cell threw `Engine has been shut down` — C6 confirmed, not
  theoretical. The same probe explains the first red run of the new test: with no warm-up the abort landed during
  `start()` and was swallowed, which is C7. Gate after all of this: units 86/86, preview-core 16/16,
  integration 34/34 (Node shim), then 102/102 units+preview natively under bun 1.4.4.
- 2026-10-30 **C1-C3, C5 implemented; the flag is gone.** `--repl`, `PI_REPL_FORCE`, the dormant state,
  `/repl on|off`, the stock-loadout capture and `FALLBACK_TOOLS` are deleted; host detection lives in
  `src/extension/diagnostics.ts` (`hostMode` / `toolsForHost`) and is unit-tested. `/repl` is read-only diagnostics.
  Live proof — a real extension load against a scripted pi host (`.smoke/hostprobe.ts`): under a Fabric-shaped host
  the loadout is untouched (`setActiveTools([fabric_exec, read, bash, edit, write])`, never execute-only), the first
  cell still reaches the kernel, and cells 1 and 2 share one interpreter; under a plain-pi host the takeover still
  happens. `registerFlag` is a throwing stub in the probe, so reaching it fails the run. Version → 0.10.1 (the `--repl` removal is the breaking half, hence a minor bump),
  CHANGELOG written, and README / ARCHITECTURE / termux / helpers / the bridge-helper example skill rewritten — they
  still advertised `pi --repl`, which is now a lie.
- 2026-10-30 **Windows process topology, measured not assumed.** A live session is a **four**-process chain: venv
  launcher → bridge → ipykernel launcher stub → the interpreter that runs cells. `Scripts/python.exe` re-execs
  (control run: spawned 9380, real interpreter 17380), and jupyter_client 8 moved the kernel pid to
  `km.provisioner.pid` — `km.pid` no longer exists, which is why the first cut of the diagnostics printed `null`.
  `bridge.py` now emits `pid` + `kernel_pid` in `ready`; the host records launcher / bridge / ipykernel separately,
  `/repl` names each distinct role once (POSIX collapses to two), and because the leaf interpreter is invisible to
  the host the diagnostics print the one kill that provably clears the chain: `taskkill /PID <root> /T /F`. A3's
  acceptance is measured: a boot → cell → `session_shutdown` cycle leaves the `python.exe` count at 2 → 2.
- 2026-10-30 **C6/C7 fixed in the engine.** An abort is armed before the boot is awaited — it used to be attached
  only after the cell was submitted, so a boot-time abort was lost and the cell ran to completion — and an expired
  abort grace leaves the engine `idle` with `reapRecovery` set rather than `shutdown`, so the next cell rebuilds and
  revives the snapshot. Two assertion fixes on the way: ipykernel sends an expression value as `result`, not stdout
  (`print(1 + 1)` in the test), and an exception surfaces as `error.name`, not stderr (`NameError` check).
  Gate: biome clean, both tsc projects clean, units+preview 105/105.
- 2026-10-30 **C4 — the nested output budget, solved as configuration rather than detection.** There is no
  reliable signal that a call arrived from a Fabric program, and guessing one would change output size behind the
  caller's back. So the cap is a setting: `PI_REPL_MAX_OUTPUT_CHARS` for the session (junk and sub-512 values fall
  back to 46,080 instead of being honoured), `maxOutputChars` per call for the caller that knows its own budget.
  Documented in README, unit-tested for the resolution rule, integration-tested for the session default applying
  and the per-call value winning.
- 2026-10-30 **Suite green end to end on Windows.** `bun test test/engine.integration.test.ts` → **35 pass /
  0 fail** (129 s), units+preview **103/103**, biome clean, both tsc projects clean. The managed venv was
  spec-probed rather than assumed: python 3.14.4 with ipykernel, jupyter_client, cloudpickle, psutil, win32com and
  win32api all importable, which is what A4 and the `psutil` marker fix were for. Only D4 (a live DraftSight smoke:
  `connect()`, push geometry, kill the kernel, reconnect through a helper, count `python.exe`) is left, and it needs
  the application running — that is the founding use case finally being exercised, not another unit test.
- 2026-10-30 **Found and removed a documentation lie while shortening README.** The rewrite surfaced a claim,
  repeated in README and `docs/ARCHITECTURE.md`, that `bash(...)`, `read(...)`, `edit(...)` and `write(...)` stay
  callable from inside a cell. Grepped `src/`, `index.ts` and `bridge.py`: no `bash` appears anywhere in the
  implementation, and `git log -S` shows `d40f7f3` added that toolbox while `1708b75` retired it for the
  helpers-only model. `toolsForHost` collapses plain-pi sessions to `execute` only, and inside a cell shell and
  files are plain Python. Both docs corrected to match the code, CHANGELOG Fixed updated, and README reduced to
  git-only install (142 → 119 lines). Lesson: a claim inherited through README rewrites never gets re-verified
  against the tree, so the shortest version of a doc is the one that forces that check.
- 2026-10-30 **Final gate on Windows, everything above measured together.** `biome check .` clean · `tsc -p .`
  and `tsc -p tsconfig.test.json` clean · units+preview **105 pass / 0 fail** · integration **36 pass / 0 fail** in
  132 s. D4 is the only item left open, and it is blocked on hardware rather than code: DraftSight is not running
  on this machine (`tasklist` finds no `DraftSight.exe`), so the live `connect()` → geometry → kill kernel →
  reconnect smoke cannot be run honestly here. It is the founding use case, so it should be run against the real
  application rather than simulated.
- 2026-10-30 **Lint + hygiene.** `biome check .` had 6 errors: two `useTemplate`, an unused `EngineManager` import,
  an unused `const global` temp dir in a helpers-prompt test (dead setup — nothing used it), two import-order
  assists. All cleared; `biome check .` is clean.
