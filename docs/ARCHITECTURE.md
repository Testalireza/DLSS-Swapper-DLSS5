# Architecture

DLSS Swapper 5 is a **single core** with **two hosts** and **one renderer**:

```
                 ┌───────────────────────────────┐
                 │  src/core/**  (pure Node)      │
                 │  env · settings · logger       │
                 │  games · runtimes · injection  │
                 │  backups · history · conflicts │
                 │  compatibility · fileOps · ops │
                 └──────────────┬────────────────┘
                                │ createServices(env)      (app-services.js)
                ┌───────────────┴────────────────┐
                │  ipc-handlers.js  (46 channels) │
                └───────┬───────────────┬────────
        Electron ipcMain│               │HTTP POST /ipc + SSE /events
                ┌───────┴──────   ┌─────────────────┐
                │ main.js +    │   │ web/server.js    │
                │ preload.js   │   │ (zero-dep)       │
                └───────┬──────┘   └────┬─────────────┘
                        │ window.dlss5  │ fetch/EventSource
                        └───────┬───────┘
                        ┌───────┴──────────────┐
                        │ src/renderer (vanilla│
                        │ JS, hash router, 8   │
                        │ pages, dialogs, CSS) │
                        └──────────────────────┘
```

The renderer never touches the filesystem or spawns processes: **every**
interaction goes through an IPC channel, so the Electron build and the browser
preview exercise the identical core.

## Composition root

`src/core/app-services.js#createServices({ env })` builds and wires:

| Service | Responsibility |
|---|---|
| `env` (AppEnv) | Paths (data/logs/backups/library), platform, command runner (injectable for tests), directory guarantees |
| `settings` | JSON settings with dot-path `set()`, defaults, reset-with-archive |
| `logger` | Daily files + in-memory ring buffer; levels DEBUG…ERROR; verbose gated by settings |
| `manifests` (ManifestStore) | Loads/validates `runtimes.json` (+ schema), collects load errors instead of crashing |
| `runtimeLibrary` | Local package storage: import/validate/hash-index/availability/delete |
| `providers` | GitHub release provider (URL templates from settings) |
| `gameStore` | Scan orchestration across detectors, merge/dedupe, manual games, ignore list |
| `analyzer` (GameAnalyzer) | PE import table → graphics API; version resources/hashes → DLSS & Streamline versions; ReShade/OptiScaler/marker forensics |
| `runtimeInstaller` | 8-step runtime install pipeline with rollback |
| `injectionLibrary` / `injectionService` | Injection package store + 9-step install/uninstall pipelines |
| `backups` (BackupService) | create/restore/finalize; hash verification; never-overwrite ids |
| `history` (HistoryService) | Append-only operation log with steps + details |
| `gpu` (GpuService) | nvidia-smi CSV + WMI fallback; RTX classification; compatibility verdict |

`ipc-handlers.js` maps the 46 `IPC.*` channels to these services. Both hosts
call the same registry: Electron via `ipcMain.handle`, the preview server via
`POST /ipc`. Progress flows through a `ctx.emit(channel, data)` callback →
`webContents.send` (Electron) or SSE broadcast (preview). Desktop-only hooks
(native dialogs, `shell.openPath`) degrade to `{ browserMode: true }`, and the
renderer responds with manual-path dialogs so no workflow dies in a browser.

## Shared modules (UMD)

`src/shared/constants.js` and `format.js` load in Node via `require()` **and**
in the renderer via plain `<script>` tags (→ `window.DLSS5Shared`). Classic
scripts are mandatory in the renderer: Electron's sandboxed renderer forbids
ES modules over `file://`.

## Renderer design

* `js/dom.js` — tiny DOM toolkit: `el('tag.class#id', props, children)`,
  badges, buttons, progress bars, step lists, kv grids.
* `js/api.js` — bridge: `invoke/on` over `window.dlss5` or fetch+SSE; path
  pickers with browser fallbacks; `openFolderVia` helper.
* `js/toast.js`, `js/dialog.js` — toast stack; modal system with focus trap,
  Esc/backdrop cancel, promise results; `showConflicts` implements the spec's
  *View Details / Continue Anyway / Cancel* loop; `showError` hides stack
  traces unless Advanced Mode.
* `js/app.js` — global state, pub/sub bus (`progress:<op>:<gameId>`), hash
  router, sidebar/topbar wiring, lazy per-game analysis cache.
* `js/pages/*.js` — eight self-registering page modules
  (`window.UI.pages.<name>`), each `{title, subtitle?, topbar?, render, destroy?}`.

No framework, no build step, no CSP-unsafe eval: the CSP header
(`default-src 'self'`) is served by the preview server and honored in Electron.

## Pipelines

**Runtime install (8 steps):** `game → running → conflicts → package → backup
→ stage → install → verify`. Staging hashes files before commit; verify
re-hashes and re-reads PE versions; failure ⇒ `removeInstalledFiles`
(hash-guarded) ⇒ `backups.restore` ⇒ history `rolled-back`.

**Injection install (9 steps):** `game → running → method → package →
conflicts → backup → install → config → verify`. Method prerequisites:
OptiScaler requires an existing OptiScaler install **or** a proxy-role file in
the package; ReShade requires an existing ReShade install (the app never
installs ReShade itself). Config edits are **append-only INI merges** — user
presets, shaders and existing keys are never clobbered; ReShade gets
`[ADDONS] AddonSearchPaths=.` ensured. Uninstall restores the backup taken at
install time.

**Conflict filtering rule:** when installing via method *M*, proxies owned by
*M* are expected prerequisites (not conflicts); unknown or cross-tool proxies
raise `needs-conflict-confirmation`. `nvngx.dll` is always inspected: a genuine
NVIDIA loader is informational, otherwise it is attributed to OptiScaler or
flagged unknown.

## Detection & analysis

* Detectors are independent modules behind one interface; failures are
  warnings, never crashes. Folder detection normalizes bin-like subdirs
  (`Binaries`, `Win64`, …) up to the recognizable game root.
* Game identity: `steam-<appid>`, `epic-<AppName>`, `xbox-<folder>`,
  `gog-<id>`, `folder-<hash12>`, `manual-<slug>-<ts>`; duplicates merge by
  resolved install dir with priority manual > steam > epic > xbox > gog > folder.
* Graphics API comes from the executable's **import table** (d3d12.dll/d3d11.dll/
  vulkan-1.dll…), not heuristics. DLSS builds are identified by PE version
  resources; DLLs lacking them fall back to the runtime hash index with a
  visible *uncertain* flag (some builds share the same resource version).

## GPU compatibility

`nvidia-smi --query-gpu=…` (CSV) is authoritative; WMI supplements driver
versions on Windows (`32.0.15.8065` → `580.65` normalization). Classification
uses **compute capability** (≥12.0 Blackwell, ≥8.9 Ada, ≥8.0 Ampere, ≥7.5
Turing) cross-checked against the marketing name; mismatches or missing data
yield `unknown` with *"could not be fully verified"* rather than a guess.
`gpuCompatibilityOverride` (Advanced Mode) is the only escape hatch and is
recorded in the verdict.

## Extension points

* **New runtime versions** — add a manifest entry (see RUNTIME-MANIFESTS.md).
* **New providers** — implement `{id, name, list(), download()}` in
  `src/core/providers/` and register it; settings gates enable/disable.
* **New detectors** — add a module returning game records; register in
  `gameStore`.
* **New injection methods** — add an `INJECTION_METHODS` entry plus a strategy
  in `injection/service.js` (prereqs, file placement, config merge, verify).
* **New GPU generations** — extend `NVIDIA_ARCHITECTURES` in constants.

## Data layout (per data dir)

```
<dataDir>/
  settings.json (+ settings-backup-*.json on reset)
  games.json                     scan cache + manual games
  history.json
  logs/YYYY-MM-DD.log
  RuntimeLibrary/<version>/…     imported packages + package.json metadata
  Injections/<id>/…              injection packages + package.json metadata
  Backups/<Game Name>-<gameId>/<backupId>/{metadata.json, files/<rel>}
```

Data dir resolution (in priority order): `DLSS5SWAPPER_DATA` env var →
Electron: the platform `userData` directory; web preview & `seed-demo`:
`<repo>/.dlss5swapper-data` (gitignored, so demo data never lands in your home
directory by accident). Tests always use isolated temp dirs.
