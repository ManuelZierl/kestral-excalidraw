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
  suppression, CAS conflict recovery, and **Keep mine as copy**.
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
explicitly exclude `scrollX`, `scrollY`, and `zoom`.

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
refused visibly.

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

Node 22 is required.

```sh
npm ci
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
