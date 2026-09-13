# Testing

The project follows the rule *"test each subsystem before moving to the next"*.
Everything runs on Node's built-in test runner — **no test framework
dependencies**. `jsdom` is an optional devDependency used only by the UI smoke
suite (that suite skips cleanly when it is absent).

```bash
npm test          # all suites            → 108/108 passing (Node 22)
npm run test:ui   # UI smoke suites only  →  30/30 passing
```

Current status (2026-09-12, Node v22, Linux):

```
# tests 108
# pass  108
# fail  0
```

## Suites

| Suite | Proves |
|---|---|
| `tests/pe-and-vdf.test.js` | PE parser reads version resources + import tables; the fixture **builder round-trips** through the parser; Steam `libraryfolders.vdf` parsing. |
| `tests/detectors.test.js` | Steam/Epic/Xbox/GOG/folder detectors against synthetic roots; bin-dir normalization (`Binaries/Win64` → game root); graceful failure when a platform store is absent. |
| `tests/analyzer.test.js` | Executable selection (real game exe wins over uninstallers/crash reporters), DX11/DX12/Vulkan from imports, DLSS + Streamline versions from PE resources, hash fallback for resource-less DLLs, ReShade/OptiScaler footprint + marker forensics, 32-bit flagging, Unreal-style layouts. |
| `tests/library-manifests.test.js` | Manifest loading/validation (9 runtimes 310.6.0→310.9.1), schema enforcement, import validation (names/roles/hashes/mismatches), hash index, availability reporting, delete. |
| `tests/install-runtime.test.js` | The 8-step pipeline end-to-end on synthetic games: backup contents + metadata, staging, verify, marker; **rollback on staging failure** (sabotaged package source); refusal when the target is not a file; game-running refusal; conflict confirmation gating; restore semantics. |
| `tests/backup.test.js` | Backup creation preserves bytes/hashes/timestamps; ids never collide or overwrite; restore validates preserved hashes; user-modified added files are kept with a warning; finalize/result bookkeeping. |
| `tests/conflicts-injection.test.js` | Proxy attribution (ReShade/OptiScaler/unknown), `nvngx.dll` classification, INI append-only merges, OptiScaler/ReShade detection+validation, the 9-step injection install (incl. method prerequisites and config exemption from hash verify) and uninstall-restore. |
| `tests/misc.test.js` | GPU classification & driver normalization (incl. WMI 4-group form), process check, INI parser edge cases, safe file ops, history service, updater, logger ring buffer/export. |
| `tests/ui-smoke.test.js` | **Renderer (jsdom):** boots `index.html`, executes every renderer script in order with a fake `window.dlss5` bridge and shape-accurate canned IPC; asserts init, all 8 routes render without failure banners, dialogs/toasts/theme/bus/DOM helpers, and that no unstubbed channel is ever called. **HTTP:** spawns the real preview server on a free port with a temp data dir and verifies static serving + MIME + CSP, `/ipc` against the real core, SSE hello event, 404s and path-traversal refusal. |

## Techniques worth knowing

* **Synthetic PE binaries.** `src/core/pe/peBuilder.js` builds real (tiny) PE
  DLLs/EXEs with version resources and import tables, so tests analyze genuine
  binaries instead of mocks. `tests/helpers.js#makeFakeGame` composes full
  game installs (decoy executables, DLSS/Streamline DLLs, ReShade/OptiScaler
  footprints).
* **Rollback is tested, not assumed.** `install-runtime.test.js` monkey-patches
  `runtimeLibrary.packageFilePath` to serve a wrong source, forcing a hash
  mismatch during staging, then asserts the game directory is restored and the
  history says `rolled-back`.
* **Determinism.** All fixtures, timestamps-of-record and pseudo-random icon
  data are seeded; no network access in tests (the updater test stubs fetch).
* **Shape-accurate UI fakes.** The jsdom bridge replays the *exact* response
  shapes the core services return (verified against `ipc-handlers.js`), so
  pages exercise their real rendering branches.

## Manual end-to-end (demo seeding)

`npm run seed-demo` drives the **real services** (no test doubles) to produce a
populated environment: 3 scanned games, 3 hashed runtime imports, 2 verified
installs, OptiScaler + ReShade injection installs, backups and history. It is
both a demo and an E2E check — any regression in the modify path fails the
seed with a non-zero exit code.

```bash
npm run seed-demo            # seeds ./.dlss5swapper-data (gitignored)
npm run webdev               # explore at http://localhost:8123
npm run seed-demo -- --reset # wipe and rebuild the demo dir
```

## Adding tests

1. Create `tests/<area>.test.js` using `node:test` + `node:assert/strict`.
2. Reuse `tests/helpers.js` (`makeTestEnv`, `makeFakeGame`, `importRuntime`,
   `fakeRunner`) — every suite gets an isolated temp data dir.
3. Keep suites hermetic: no network, no real user paths, cleanup in `after()`.
4. Run `npm test` (the quoted glob `"tests/*.test.js"` is expanded by Node
   itself, so it works on Windows shells too).
