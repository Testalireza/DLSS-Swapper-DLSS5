# Building & packaging

## Prerequisites

* **Node.js 20+** (22 LTS recommended) and npm.
* For Windows installers: build **on Windows** (electron-builder's NSIS step is
  Windows-native; cross-building from Linux/macOS needs Wine and is not
  supported by this repo's scripts).
* No native modules anywhere — there is nothing to `node-gyp` rebuild.

## Development

```bash
npm install          # electron, electron-builder, jsdom (devDependencies only)
npm start            # run the desktop app from source (needs a display)
npm run webdev       # zero-dependency browser preview on :8123 (same core)
npm run seed-demo    # optional: populate the demo data dir with real artifacts
npm test             # full test suite
npm run icons        # regenerate resources/icons/* (pure Node, deterministic)
```

The app has **zero runtime dependencies**: everything (PE parsing, VDF
parsing, INI merging, hashing, backups, HTTP preview server) is implemented in
`src/`. `electron`, `electron-builder` and `jsdom` are devDependencies only.

## Packaging (Windows)

```bash
npm run dist         # electron-builder --win  →  dist/
```

Produces, per the `build` config in `package.json`:

* **NSIS installer** (`DLSS Swapper 5 Setup <version>.exe`) — assisted install
  (`oneClick: false`, user-selectable directory).
* **Portable executable** (`DLSS Swapper 5 <version>.exe`).

Config highlights (`package.json → build`):

| Key | Value |
|---|---|
| `appId` | `com.testalireza.dlssswapper5` |
| `productName` | `DLSS Swapper 5` |
| `files` | `main.js`, `preload.js`, `src/**/*`, `resources/**/*`, `package.json` |
| `extraResources` | `resources/RuntimeManifests` → `<resources>/RuntimeManifests` |
| `win.icon` | `resources/icons/icon.ico` (generated, 256/48/32 px) |
| `directories.output` | `dist/` |

`npm run pack` builds an unpacked directory (`electron-builder --dir`) for
quick smoke tests of the packaged layout.

### Icons

`resources/icons/icon.{png,ico}` are **generated**, not hand-drawn:
`tools/make-icons.js` renders the tile (SDF rasterizer) and writes PNGs plus a
multi-size PNG-compressed ICO with a hand-rolled encoder. Re-run
`npm run icons` after changing the design; output is deterministic.

### Runtime manifests in the package

`runtimes.json` ships inside the app resources (`extraResources`) and is
resolved at startup by `resolveResourcesDir()` (works both from source and
from packaged `process.resourcesPath`). Users can still add versions at
runtime via imports/providers — the manifest is data, not code.

### Code signing (optional)

Unsigned Windows builds trigger SmartScreen warnings. To sign, configure
electron-builder's `win.certificateFile` / `certificatePassword` (or a
`signtool`-based `afterSign` hook) with your own certificate; this repo
deliberately ships no signing configuration or credentials.

## Data directories at runtime

| Host | Default data dir | Override |
|---|---|---|
| Electron app | platform `userData` (e.g. `%APPDATA%/dlss-swapper-5`) | `DLSS5SWAPPER_DATA` |
| Web preview / `seed-demo` | `<repo>/.dlss5swapper-data` (gitignored) | `DLSS5SWAPPER_DATA` |
| Tests | isolated `os.tmpdir()` dirs | n/a |

Inside: `settings.json`, `games.json`, `history.json`, `logs/`, `Backups/`,
`RuntimeLibrary/`, `InjectionLibrary/`, `staging/`.

## Troubleshooting

* **Port 8123 in use** — `PORT=9000 npm run webdev` (and `HOST` to bind
  elsewhere; the preview binds `0.0.0.0` by default for container use).
* **Empty library in the preview** — run `npm run seed-demo` first, or point
  `DLSS5SWAPPER_DATA` at a directory that has state.
* **Electron won't start in headless containers** — expected; use
  `npm run webdev` there (this is how the repo's UI is tested via jsdom +
  HTTP instead of a display server).
* **`npm test` glob on Windows** — the script quotes the glob
  (`node --test "tests/*.test.js"`), which Node expands itself; no shell
  globbing required.
