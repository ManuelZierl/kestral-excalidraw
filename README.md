# Kestral Excalidraw

An independent, backend-free Kestral app that packages Excalidraw as a
sandboxed frontend. It does not modify or link against Kestral source code.
The installable package is `dist/`; the app is not a standalone desktop or web
application.

## Current Scope

- One host-managed document per canvas. Document metadata owns title, trash
  state, frontend-derived summary/search projection, schema version, and bounded
  applied-proposal receipts; opaque content owns the complete scene and assets.
- Create, rename, duplicate, trash, restore, purge, autosave, stale-load
  suppression, CAS conflict recovery, and **Keep mine as copy**. Conflict copies save the complete scene in one
  document create; copy names are bounded by UTF-8 bytes without splitting code points.
- Restores the last active canvas and each canvas's zoom and pan position from
  private, revisioned surface state. View changes are saved independently from
  durable scene content and never make a canvas document dirty.
- Frontend-only scene validation and semantic text, shape, grouping, frame,
  reorder, update, delete, and restore operations.
- Complete scenes up to the demonstrated 7 MiB size, sent in host-bounded
  384 KiB raw chunks.
- No app backend process, MCP server, Node runtime, network client, ambient
  filesystem access, telemetry, or ambient credentials at runtime.

## Current Host Contract

`src/dataV2Adapter.ts` owns durable canvas access through the exact
`window.appHost.data.v2` methods:

- `readSnapshot({ expectedGeneration?, reads })` with `document-list`,
  `document-get`, and `document-content` reads. Related reads use one coherent
  generation and expected generations reject mixed snapshots.
- `beginBatch({ mutationId, expectedGeneration, operations: [], documents })`.
  Document creates/replacements include `stageId`, metadata, content length,
  and `sha256-<64 lowercase hex>` content hash.
- `appendDocumentChunk({ mutationId, batchId, documentId, chunkIndex,
  contentBase64 })`, `commitBatch({ mutationId, batchId })`, and
  `abortBatch({ mutationId, batchId })`. Each request gets a fresh mutation ID.
- Host document fields are `id`, `revision`, `createdAt`, `updatedAt`,
  `metadata`, `contentSha256`, and `contentLength`.

Metadata-only rename/trash/restore/rejection uses `update-metadata` and does
not reupload scene content. Scene changes use staged `create` or `replace`.
`src/surfaceState.ts` separately uses `getState` and `putState` with CAS
revisions for the active canvas and whitelisted camera fields. Canvas documents
explicitly exclude `scrollX`, `scrollY`, and `zoom`. Each independent read starts
a fresh snapshot; only its related reads/chunks share the captured generation.
Writes acquire a fresh generation without replacing the expected document
revision, so unrelated writes do not permanently block refresh or autosave.

Kestral owns the document store and surface-state persistence. The app receives
only the host bridge exposed to its sandboxed surface; it cannot read host
secrets or choose arbitrary files or network destinations. Host-managed canvas
data is retained across ordinary app updates and is subject to Kestral's app
data retention and purge controls.

## Proposal Review

Chat can request the declared `propose-canvas-operations` capability. Its
consumer grant is an all-resources, requires-approval standing request. The
capability creates a host-provenance-stamped `canvas-operations-proposal`
artifact; it never directly mutates a canvas.

On load and refresh, the surface lists its own artifacts and shows pending
proposals with the target canvas, expected revision, operation count, **Apply**,
and **Reject**. The frontend validates the complete envelope and strict bounded
semantic payload. Apply and reject use document CAS. Applied or rejected
proposal IDs are recorded in bounded document metadata receipts, preventing
replay. Malformed, stale, missing-target, and already-receipted proposals are
refused visibly. Pending manual edits are saved before a proposal decision;
that save can make a proposal stale rather than silently rebasing it. A proposal
must still match both its target revision and host generation at commit time.
Receipt storage is limited to 32 decisions per canvas and fails closed at that
bound; old receipts are never evicted to make replay possible. Copying a canvas
creates a new target identity and a fresh receipt history.

Chat's only declared access is an approval-required request to create a
reviewable proposal artifact. Chat cannot directly mutate a canvas. The
host-generated artifact provenance and the receipt recorded by the app connect a
decision back to the originating run; ordinary direct surface edits use the
host's managed-data action boundary.

## Data Discontinuity

Pre-alpha data has no compatibility requirement. This conversion intentionally
does **not** import format-1 files, the former MCP store, or native backend
data. Existing canvases must be recreated as documents in the new `canvases`
collection. Proposal artifacts from before this contract are not imported.

## Build and Test

Node.js `>=22.19 <23` is required for building and testing only. The packaged
app is supported on Kestral's Windows x86_64 and Linux x86_64 alpha releases and
needs no app runtime or backend process.

```sh
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npm run test:package-schema -- /path/to/versioned/kestral/schemas/app.schema.json
npm run test:reproducible
npm run package:digest
```

Node.js 22.19 is the supported build and test runtime. Kestral, not this app,
runs the resulting package at runtime. `npm run build` regenerates dependency
notices, builds the self-contained surface, copies the app license and notices
into the package, and writes integrity hashes for every shipped asset. The
package contains only:

```text
dist/
|-- app.json
|-- ui/index.html
|-- ui/LICENSE
`-- ui/THIRD-PARTY-NOTICES.txt
```

`app.json` uses `backend.kind: "none"`, one document collection, exact v2
limits, one proposal capability/artifact type, and Chat's approval-required
consumer grant. `npm run package:digest` prints the Kestral host-canonical
package digest. `npm run check:generated` checks committed generated output;
CI validates the manifest against a pinned public Kestral schema commit and
checks two-build reproducibility.

The immutable `0.1.4` package at source commit `1c2fd93144b6c5b00a957ef9b2726293a55a180a`
is the predecessor for the `0.1.5` update test.
Updating, disabling, or uninstalling with data retained preserves host-managed
canvas documents and private view state. Purge removes the app's canvas
collection and host-owned app state/config; historical Runs and artifacts retain
their normal Kestral provenance. The app makes no direct network connection.

## Lifecycle Evidence

The manual host lifecycle attestation and its non-overwriting release workflow
are documented in [RELEASE-EVIDENCE.md](RELEASE-EVIDENCE.md). The workflow
validates the exact source commit, package digest, app identity, and nine
Whiteboard observations; it does not run the Tauri host or claim that CI
reproduced the manual UI run.

## Development Preview

```sh
npm run dev
```

Without a Kestral surface bridge the preview uses a non-persistent canvas. It
is intended for editor and responsive-layout work only and does not represent
the persisted host contract.

## Maintenance And Support

Manuel Zierl maintains this repository. Report ordinary defects through
[GitHub Issues](https://github.com/ManuelZierl/kestral-excalidraw/issues) and
security-sensitive defects through [private vulnerability reporting](https://github.com/ManuelZierl/kestral-excalidraw/security/advisories/new).
