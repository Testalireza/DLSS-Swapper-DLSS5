# DLSS Swapper 5 — DLSS Runtime Manager with DLSS 5 Neural Rendering support

A Windows desktop application (Electron) that finds your games, manages the
NVIDIA DLSS runtime DLLs inside them **safely** (backup-first, hash-verified,
rollback-capable), and adds a **DLSS 5 Neural Rendering** workflow built on
OptiScaler- and ReShade-style injection packages.

> **Original implementation.** Public projects
> [rakanki911/DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper) (UX /
> workflow) and [RankFTW/RHI](https://github.com/RankFTW/RHI) (injection /
> configuration concepts) were studied for architecture and UX only. No code or
> assets from them (or from NVIDIA) are included.

---

## What it does

| Area | Capability |
|---|---|
| **Game detection** | Steam (all library folders via `libraryfolders.vdf`), Epic Games manifests, Xbox / Microsoft Store, GOG Galaxy, custom folders, manual add. De-duplicated by resolved install directory. |
| **Game analysis** | Real PE parsing: graphics API from the executable's **import table** (DX11/DX12/Vulkan), DLSS / Streamline presence and versions from **DLL version resources**, falling back to content hashes against the runtime index — never from file names. |
| **Runtime library** | JSON manifest database covering **310.6.0 → 310.9.1** (expandable, schema-validated). Pluggable sources: local library, GitHub release providers, user imports (validated by structure, names and SHA-256). |
| **Backups** | Every file that would be replaced is preserved first — original bytes, SHA-256, timestamps, detected runtime version — into a timestamped backup that is **never overwritten**. Restore verifies preserved hashes before writing and refuses to delete files you modified yourself. |
| **Version switching** | 8-step pipeline with live progress checklist: detect → not-running → conflicts → validate → backup → stage → install → verify. Any failure **rolls back automatically** from the backup and records the outcome in history. |
| **DLSS 5 Neural Rendering** | Import community injection packages; GPU/RTX detection (RTX 20/30/40/50 via compute capability, cross-checked against the reported name — never assumed); two install methods (**OptiScaler**, **ReShade add-on**) with append-only config merging that never clobbers your presets/shaders; full uninstall-and-restore. |
| **Conflict awareness** | Proxy-DLL and modding-tool detection (ReShade, OptiScaler, Special K, unknown proxies) with *View Details / Continue Anyway / Cancel*. Nothing is ever auto-deleted. |
| **History & logging** | Per-operation timeline with steps and technical details; daily rotating logs with a ring buffer; stack traces only in Advanced Mode. |

---

## Quick start

Requirements: **Node.js 20+** (22 recommended). Windows is the target platform
for the desktop app; the browser preview and the entire core also run on
Linux/macOS, which is how this repository is tested in CI-like fashion.

```bash
npm install            # devDependencies only (electron, electron-builder, jsdom)

# 1) optional but recommended: seed a fully working demo environment
npm run seed-demo      # synthetic games, imports, installs, backups, history

# 2a) browser preview of the real app (same core services, no Electron)
npm run webdev         # → http://localhost:8123

# 2b) or the actual desktop app (needs a display; Windows/macOS/Linux)
npm start
```

The demo seeder builds **real artifacts** through the app's own services:
three synthetic game installs (valid PE executables with import tables and
version resources), three imported+hashed runtime packages, two verified
runtime installs with backups, and one OptiScaler plus one ReShade injection
install. Everything you see afterwards is genuine state — inspect
`.dlss5swapper-data/` (gitignored) to see backups, markers and history files.

```bash
npm test               # 108 tests across 9 suites (node:test + jsdom)
npm run test:ui        # just the UI smoke suites
npm run icons          # regenerate resources/icons/* procedurally
```

---

## The safety model (why you can trust the modify path)

1. **Backup before bytes.** `autoBackup` is on by default; every install
   (runtime or injection) creates a backup of every file it will replace or
   edit *before* staging anything. Backup ids are timestamped and unique —
   existing backups are never overwritten.
2. **Atomic-ish staging.** Files are copied to a staging area and hashed
   there; a staging failure aborts before the game directory is touched.
3. **Verify or roll back.** After install, every committed file is re-hashed
   (and DLLs re-read for version metadata). Any mismatch triggers an automatic
   restore from the backup and a `rolled-back` history entry.
4. **Running games are respected.** Modifications are refused while the game
   process is detected (`blockIfGameRunning`).
5. **Your files, your decisions.** Conflicting third-party files are reported
   with severity and ownership; the app never silently deletes or overwrites
   user content. Restores keep files you changed yourself and warn instead of
   deleting them.
6. **Traceability.** Every modified game directory receives a
   `.dlss5swapper-marker.json` describing what was installed, from where, with
   which hashes — used for status display, uninstall and forensics.
7. **Uncertainty is reported, not hidden.** GPU compatibility can answer
   *"could not be fully verified"*; DLLs without version resources are
   identified by hash with a visible warning; 32-bit executables are flagged.

---

## UI tour

Sidebar navigation with seven sections (light theme `#F0F0F0` / accent
`#8BCA84`, plus a full dark theme):

1. **Games** — searchable, sortable card grid; lazy per-game badges for
   graphics API, DLSS version, Streamline, injection status; rescan and
   manual-add in the top bar; hide/remove per game.
2. **Game detail** — analysis panel (executable, API evidence, DLSS/Streamline
   versions), version selector with the progress-checklist install dialog,
   conflict review, *Restore Original Files* with backup picker + dry-run
   preview, per-game backups, injection quick status, Advanced-Mode executable
   picker.
3. **DLSS 5 Neural Rendering** — GPU compatibility card (status, reasons,
   warnings, override in Advanced Mode), injection package library (import
   with per-file role overrides + config directives), install panel with
   OptiScaler/ReShade method cards, GPU gate dialog, uninstall-and-restore.
4. **DLSS Runtime Library** — manifest table (version, DLSS/Streamline
   versions, channel, library status), expandable file detail with stored
   hashes/sizes, import (with Advanced-Mode mismatch override), provider
   download with live progress, delete.
5. **Backups** — grouped by game with operation, before/after versions,
   preserved-file counts; details modal; restore with dry-run; delete; open
   location.
6. **Installation History** — timeline grouped by day, result badges, step
   detail and technical JSON, one-click restore of the associated backup.
7. **Options** — theme, scanning sources, custom folders, backup location,
   auto-backup/verify/conflict/running-game toggles, Advanced Mode + verbose
   logging, live log viewer + export, runtime source templates, update check,
   reset settings (archived, never destroyed).
8. **About** — app info, safety promises, credits, links, disclaimer.

Every dialog is focus-trapped and Esc-cancelable; toasts, tooltips, empty
states and natural scrolling throughout. The same renderer runs inside
Electron and in the zero-dependency browser preview.

---

## Runtime manifest system

`resources/RuntimeManifests/runtimes.json` describes every supported runtime
(version, DLSS/Streamline versions, channel, minimum driver, per-file roles
and expected hashes). It is **data, not code**: adding a runtime means adding
an entry that conforms to `runtimes.schema.json` — no release required for new
versions. Providers (GitHub release URL templates, configurable in Options)
and manual imports feed the local library; imports are validated for file
names, roles, PE version resources and hashes before acceptance.

See **[docs/RUNTIME-MANIFESTS.md](docs/RUNTIME-MANIFESTS.md)**.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Service map, IPC surface (46 channels), renderer design, PE parser, install/injection pipelines, extension points. |
| [docs/TESTING.md](docs/TESTING.md) | How to run every suite, what each of the 9 suites proves, current results (108/108), how to add tests, manual E2E via `seed-demo`. |
| [docs/BUILD.md](docs/BUILD.md) | Packaging the Windows installer/portable with electron-builder, icons, data directories, troubleshooting. |
| [docs/RUNTIME-MANIFESTS.md](docs/RUNTIME-MANIFESTS.md) | Manifest schema, adding versions, providers, import validation rules. |

---

## Project layout

```
main.js / preload.js          Electron entry + contextBridge (window.dlss5)
src/shared/                   UMD modules shared by Node core and renderer
  constants.js                app identity, 46 IPC channels, roles, methods, results
  format.js                   version compare, bytes/date formatting, ids
src/core/
  env.js settings.js logger.js hash.js
  pe/                         PE headers/imports/version-resource parser + fixture builder
  games/                    detectors (steam/epic/xbox/gog/folders), store, analyzer
  runtimes/                 manifest store + runtime library (import/validate/hash index)
  runtimes/providers/       GitHub release provider (URL templates)
  injection/                INI merge, ReShade/OptiScaler detection, library, 9-step service
  backups/ history/         backup service (create/restore/finalize), history log
  conflicts/                proxy attribution + conflict detector
  compatibility/            GPU detection & RTX classification (nvidia-smi/WMI)
  fileOperations/           process check, safe atomic file ops
  ops/installRuntime.js     8-step runtime installer with rollback
  app-services.js           composition root (Electron main AND web server)
src/main/ipc-handlers.js    the single IPC registry used by both transports
src/web/server.js           zero-dependency preview server (POST /ipc, SSE /events)
src/renderer/               vanilla-JS UI: css/, js/, js/pages/ (8 pages), index.html
resources/RuntimeManifests/ runtimes.json + runtimes.schema.json
resources/icons/            generated icons (tools/make-icons.js)
tests/                      9 node:test suites incl. jsdom UI smoke + HTTP integration
tools/                      make-icons.js, seed-demo.js
```

---

## Credits, license, disclaimer

* Inspired by (no code copied): **rakanki911/DLSS5-Swapper**, **RankFTW/RHI**.
* Built with Electron + vanilla JavaScript; **zero runtime dependencies**.
  Tests use `node:test` and (optionally) `jsdom`.
* License: **MIT** — see [LICENSE](LICENSE).

> **Disclaimer.** This project is not affiliated with, endorsed by, or
> sponsored by NVIDIA Corporation. DLSS® and GeForce RTX™ are trademarks of
> NVIDIA Corporation. Modifying game files can violate some games' terms of
> service and may trigger anti-cheat detections in online titles — use
> injection features in single-player/offline contexts at your own risk.
> Always keep your backups.
