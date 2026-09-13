# Runtime manifest system

The set of manageable DLSS runtimes is **data**, described by
`resources/RuntimeManifests/runtimes.json` and validated against
`resources/RuntimeManifests/runtimes.schema.json`. Adding support for a new
runtime version never requires a code change or an app release: add a manifest
entry (or let users import the files manually).

Current coverage: **310.6.0, 310.6.1, 310.6.2, 310.7.0, 310.7.129, 310.8.0,
310.8.1, 310.9.0, 310.9.1** (9 entries).

## File structure

```jsonc
{
  "$schema": "./runtimes.schema.json",
  "schemaVersion": 1,
  "generated": "2026-…",            // informational
  "notes": [ "…" ],                 // informational
  "fileCatalog": {                  // shared vocabulary of file roles
    "dlss-core":        { "role": "dlss-core", "required": true,  "description": "nvngx_dlss.dll — the DLSS runtime itself" },
    "dlss-framegen":    { "role": "dlss-framegen", "required": false },
    "streamline-plugin":{ "role": "streamline-plugin", "required": false },
    "…": {}
  },
  "runtimes": [
    {
      "id": "310.9.1",
      "version": "310.9.1",          // dotted numeric, compared semver-wise
      "dlssVersion": "310.9.1",      // version resource expected inside the core DLL
      "streamlineVersion": "2.12.129",
      "channel": "stable",           // stable | beta | legacy
      "minimumDriver": "580.00",
      "notes": "…",
      "files": [
        { "name": "nvngx_dlss.dll",  "role": "dlss-core",   "required": true,
          "sha256": null,            // optional pinning hash (null = accept any, identified by PE version)
          "sizeBytes": null },
        { "name": "sl.common.dll",   "role": "streamline-plugin", "required": false }
      ],
      "sources": [                  // optional per-runtime provider hints
        { "provider": "github",
          "url": "https://example.org/releases/{version}/{file}",
          "notes": "…" }
      ]
    }
  ]
}
```

Rules enforced by `ManifestStore`:

* `schemaVersion` and `runtimes` are required; every runtime needs `id`,
  `version` (dotted-numeric pattern) and a non-empty `files` array.
* Unknown roles fall back to `other` with a **load warning**, not a crash —
  a newer manifest than the app degrades gracefully and the Runtimes page
  surfaces `loadErrors` in the UI.
* Duplicate versions are rejected with a load error listing both entries.
* `sha256`/`sizeBytes`, when present, are enforced at import and at staging
  time (hash mismatch ⇒ install aborts and rolls back).

## Adding a runtime version

1. Append an entry to `runtimes` following the shape above. Keep `files`
   honest: `required: true` only for files whose absence must fail an install.
2. Optionally pin `sha256`/`sizeBytes` once trustworthy hashes are known.
3. Optionally attach `sources` (GitHub release URL templates).
4. Validate: `node -e "require('./src/core/runtimes/manifests')"` is exercised
   by `tests/library-manifests.test.js` — run `npm test`. The UI shows the new
   row immediately (Runtimes page) and game pages offer it in the selector.

## Where packages come from (providers)

`src/core/runtimes/providers/index.js` hosts a small registry:

* **Local library** (`RuntimeLibrary/<version>/`) — anything imported or
  downloaded lands here with a `package.json` sidecar (origin, timestamps,
  per-file SHA-256). Installs always read from the library, never from the
  network directly.
* **GitHubProvider** — tries, in order: (a) the runtime entry's `sources[]`
  templates, then (b) the global templates from
  `settings.runtimeSources.github.repos` (editable in Options → *Runtime
  repository management*). Placeholders `{version}` and `{file}` are expanded
  per required file. Downloads are hashed; if the manifest pins a `sha256`,
  a mismatch discards the file and tries the next template.
* **User import** — Runtimes page → *Import*: pick files; the library
  validates names against the manifest entry, assigns roles, reads PE version
  resources, computes hashes, and refuses mismatches unless Advanced Mode
  explicitly overrides (the override is recorded in the package metadata).

Adding a new provider type = one class implementing
`{ id, name, enabled(settings), download(version, rt, onProgress) }` plus
registration in `ProviderRegistry`; settings get an enable/disable flag.

## Import validation checklist (what the library enforces)

1. Every selected path is a readable file.
2. The manifest knows the target version.
3. All `required` files are present with exact names.
4. Roles are assigned from names (or explicit overrides in Advanced Mode).
5. DLLs are PE-parsed: version resources must match the manifest's
   `dlssVersion`/`streamlineVersion` (mismatch ⇒ error, or an audited
   Advanced-Mode override with a warning).
6. Hashes are computed and stored; pinned manifest hashes must match.
7. The package is written atomically into the library with its sidecar.
