# Lifecycle Evidence

This repository publishes format-1 lifecycle evidence for the external Kestral
Whiteboard app. The evidence is an attestation written after a real manual
Kestral desktop/Tauri run. The workflow validates the checked-out source,
package identity, canonical package digest, and recorded observations; it does
not launch Kestral or reproduce the Tauri run. Dispatch requires the exact app
`source_commit` and an explicit `tauri_tested: true` manual attestation.

## Two-Commit Boundary

Use the clean Whiteboard source commit that produced `dist/` as the evidence
source commit. A later Kestral metadata-only commit may record the evidence URL
and digest. Do not change the tested core commit to record its own evidence.

## Manual Observations

Before dispatching **Release evidence**, run the lifecycle checks against the
exact `dist/` package, lowercase 40-hex app `source_commit`, and exact Kestral
host commit named in the dispatch inputs. Set `tauri_tested` to `true` after
the real Tauri run. Keep the `observations` input as this exact JSON shape.
Every check is required, must have `status: "passed"`, and must describe the
retained manual run:

```json
{
  "tested_at": "2026-08-06T12:00:00Z",
  "platforms": ["windows-x86_64", "linux-x86_64"],
  "lifecycle": {
    "package_inspection": { "status": "passed", "observation": "..." },
    "permission_denial": { "status": "passed", "observation": "..." },
    "activation": { "status": "passed", "observation": "..." },
    "representative_action": { "status": "passed", "observation": "..." },
    "restart": { "status": "passed", "observation": "..." },
    "update_data_preservation": { "status": "passed", "observation": "..." },
    "disable_enable": { "status": "passed", "observation": "..." },
    "keep_data_uninstall": { "status": "passed", "observation": "..." },
    "purge_data_uninstall": { "status": "passed", "observation": "..." }
  }
}
```

The Whiteboard-specific observations must cover:

1. Package inspection without executing package code, including `com.ma-zierl.kestral-excalidraw`, `backend.kind: "none"`, host-managed `canvases` data, and the proposal request.
2. Denying Chat's approval-required `propose-canvas-operations` request, with no grant created and no board mutation.
3. Activation showing the Whiteboard surface and host-managed board data available.
4. A representative board update through the normal Kestral data.v2 action boundary, not direct filesystem access.
5. Restart restoring the selected canvas, scene, title, and independently stored view state.
6. Updating the app while preserving or explicitly migrating the host-owned canvas document and surface state.
7. Disabling and re-enabling the app, with its authority and surface absent while disabled.
8. Keep-data uninstall, reinstall, and retained host-managed canvas data, including a Whiteboard update or conflict copy if used in the run.
9. Purge-data uninstall with canvas documents, app config, and secrets absent after the purge.

The generator rejects unknown fields, missing checks, duplicate platforms,
malformed timestamps, failed statuses, and empty observations. It also rejects
any source repository other than
`https://github.com/ManuelZierl/kestral-excalidraw`, any app ID other than
`com.ma-zierl.kestral-excalidraw`, a source `HEAD` different from
`GITHUB_SHA`, a dirty checkout, or a digest different from the supplied
canonical digest. The generator deliberately does not impose a backend policy
on arbitrary packages; the Whiteboard package's backend-free and host-managed
board contract is checked by its package tests and the pinned schema check.

`workflow_url` is derived from `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, and
`GITHUB_RUN_ID`; it is not accepted as manual input.

## Dispatch Gates

The workflow checks out the public Kestral package schema at the pinned commit
`82a983a268911e7a1958b4c6eab06dde334070b1` into `.kestral-contract`. It runs the
existing typecheck, package tests, schema validation, reproducibility check,
generated-output check, and checked-in `dist/` diff gate before generating
evidence. It never uses a parent-relative schema path.

Dispatch with a new `release_tag` matching the workflow's conservative syntax.
The tag must not already exist as either a GitHub release or remote
`refs/tags/<tag>`. Publication creates a new GitHub release and uploads an
asset named with the app version and source commit. The workflow has no
overwrite or clobber path, so an existing release or remote tag fails and the
source-commit asset is independently addressable by its immutable release URL
and SHA-256 bytes. Start the dispatch from a ref whose `GITHUB_SHA` matches
`source_commit`; a mismatch is rejected.

The evidence asset is an attestation, not the app package and not a grant of
special authority to Whiteboard.
