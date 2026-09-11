import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageDigest } from "../scripts/package-digest.mjs";
import {
  APP_ID,
  LIFECYCLE_CHECKS,
  REPOSITORY,
  createEvidence,
  validateObservations,
  workflowUrl,
} from "../scripts/release-evidence.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function observations() {
  return {
    tested_at: "2026-08-06T12:00:00Z",
    platforms: ["windows-x86_64", "linux-x86_64"],
    lifecycle: Object.fromEntries(LIFECYCLE_CHECKS.map((check) => [check, {
      status: "passed",
      observation: `Manual Whiteboard observation for ${check}.`,
    }])),
  };
}

test("derives an Actions URL only from GitHub run environment", () => {
  assert.equal(workflowUrl({
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "ManuelZierl/kestral-excalidraw",
    GITHUB_RUN_ID: "12345",
  }), `${REPOSITORY}/actions/runs/12345`);
  assert.throws(() => workflowUrl({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" }), /GITHUB_SERVER_URL/);
});

test("requires exactly nine passed lifecycle observations", () => {
  const value = observations();
  assert.equal(Object.keys(value.lifecycle).length, 9);
  assert.throws(() => validateObservations({ ...value, unexpected: true }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, extra: { status: "passed", observation: "x" } } }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, proposal_denial: undefined } }), /fields differ/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, activation: { status: "failed", observation: "x" } } }), /must be 'passed'/);
  assert.throws(() => validateObservations({ ...value, lifecycle: { ...value.lifecycle, restart: undefined } }), /must be an object/);
  assert.throws(() => validateObservations({ ...value, platforms: ["linux-x86_64", "linux-x86_64"] }), /duplicates/);
});

test("creates evidence for the exact app without imposing a generic backend rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestral-excalidraw-release-evidence-"));
  await mkdir(join(root, "dist", "ui"), { recursive: true });
  await writeFile(join(root, "dist", "ui", "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "kestral-excalidraw", version: "0.1.4" }));
  await writeFile(join(root, "dist", "app.json"), JSON.stringify({
    id: APP_ID,
    version: "0.1.4",
    backend: { kind: "process" },
    data: { kind: "host-managed" },
    manifest: {},
    integrity: { algorithm: "sha256", assets: { "ui/index.html": "sha256-ignored" } },
  }));
  const digest = await packageDigest(join(root, "dist"));
  const context = {
    root,
    observations: observations(),
    expectedPackageDigest: digest,
    hostVersion: "0.1.0-alpha.1",
    hostCommit: HEAD,
    env: {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "ManuelZierl/kestral-excalidraw",
      GITHUB_RUN_ID: "12345",
      GITHUB_SHA: HEAD,
    },
    git: (args) => args[0] === "rev-parse" ? HEAD : "",
    expectedAppId: APP_ID,
    expectedRepository: REPOSITORY,
  };
  const evidence = await createEvidence(context);
  assert.deepEqual(evidence.app, { id: APP_ID, version: "0.1.4" });
  assert.equal(evidence.source.clean, true);
  assert.equal(evidence.package.digest, digest);
  assert.equal(evidence.run.workflow_url, `${REPOSITORY}/actions/runs/12345`);
  assert.deepEqual(evidence.extension_contributions, []);
  const manifestPath = join(root, "dist", "app.json");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace(APP_ID, "com.example.other"));
  await assert.rejects(() => createEvidence(context), /app identity/);
  await writeFile(manifestPath, manifest);
  await assert.rejects(() => createEvidence({ ...context, expectedAppId: "com.example.other" }), /expected app ID/);
  await assert.rejects(() => createEvidence({ ...context, expectedRepository: "https://github.com/ManuelZierl/other" }), /expected repository/);
  await assert.rejects(() => createEvidence({ ...context, expectedPackageDigest: "sha256-0000000000000000000000000000000000000000000000000000000000000000" }), /package digest mismatch/);
  await assert.rejects(() => createEvidence({ ...context, env: { ...context.env, GITHUB_SHA: "fedcba9876543210fedcba9876543210fedcba98" } }), /does not match source HEAD/);
  await assert.rejects(() => createEvidence({ ...context, env: { ...context.env, GITHUB_REPOSITORY: "ManuelZierl/other" } }), /source repository/);
  await assert.rejects(() => createEvidence({ ...context, git: (args) => args[0] === "rev-parse" ? HEAD : " M package.json" }), /source checkout is not clean/);
});
