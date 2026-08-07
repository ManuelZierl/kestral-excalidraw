import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../dist/", import.meta.url);
const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const MAX_SURFACE_HTML_BYTES = 32 * 1024 * 1024;

test("package is a backend-free data.v2 app", async () => {
  const manifest = await manifestFile();
  assert.equal(manifest.id, "com.ma-zierl.kestral-excalidraw");
  assert.equal(manifest.version, packageMetadata.version);
  assert.deepEqual(manifest.backend, { kind: "none" });
  assert.deepEqual(manifest.manifest.capabilities.map(({ name }) => name), ["propose-canvas-operations"]);
  assert.deepEqual(manifest.manifest.artifact_types.map(({ name }) => name), ["canvas-operations-proposal"]);
  assert.deepEqual(manifest.manifest.grant_requests, []);
  assert.equal(manifest.consumer_grant_requests[0].holder, "chat");
  assert.equal(manifest.consumer_grant_requests[0].request.condition, "requires-approval");
  assert.deepEqual(manifest.consumer_grant_requests[0].request.data_scope, { kind: "all-resources" });
  assert.equal(manifest.data.kind, "host-managed");
  assert.equal(manifest.data.contract_version, 2);
  const data = (await manifestFile()).data;
  assert.deepEqual(Object.keys(data.collections), []);
  assert.deepEqual(Object.keys(data.documents), ["canvases"]);
  assert.deepEqual(data.documents.canvases.operations, ["get", "list", "create", "replace", "update-metadata", "delete"]);
  assert.equal(data.documents.canvases.limits.content_bytes, 8 * 1024 * 1024);
  assert.equal(data.documents.canvases.limits.metadata_bytes, 65536);
  assert.equal(data.limits.batch_operations, 2048);
  assert.deepEqual(data.exports, []);
  assert.equal(data.proposals[0].target.document_collection, "canvases");
  assert.deepEqual(data.proposals[0].payload_schema, manifest.manifest.capabilities[0].input_schema.properties.payload);
  assert.deepEqual(manifest.manifest.artifact_types[0].json_schema, manifest.manifest.capabilities[0].output_schema);
  assert.deepEqual(Object.keys(manifest.integrity.assets).sort(), ["ui/LICENSE", "ui/THIRD-PARTY-NOTICES.txt", "ui/index.html"]);
  assert.deepEqual(await packageFiles(), ["app.json", "ui/LICENSE", "ui/THIRD-PARTY-NOTICES.txt", "ui/index.html"]);
});

test("package integrity covers every shipped payload file", async () => {
  const manifest = await manifestFile();
  const declared = Object.keys(manifest.integrity.assets).sort();
  assert.deepEqual((await packageFiles()).filter((path) => path !== "app.json"), declared);
  for (const [path, expected] of Object.entries(manifest.integrity.assets)) {
    const bytes = await readFile(new URL(path, packageRoot));
    assert.equal(`sha256-${createHash("sha256").update(bytes).digest("hex")}`, expected);
  }
  const notices = await readFile(new URL("ui/THIRD-PARTY-NOTICES.txt", packageRoot), "utf8");
  assert.match(notices, /@excalidraw\/excalidraw@0\.18\.1/);
  assert.match(notices, /License: MIT/);
});

test("surface is self-contained and contains no headless runtime markers", async () => {
  const bytes = await readFile(new URL("ui/index.html", packageRoot));
  assert.ok(bytes.byteLength <= MAX_SURFACE_HTML_BYTES);
  const html = bytes.toString("utf8");
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /backend\/server|mcp-stdio|APP_HOST_DATA_DIR|child_process/i);
  const firstScript = html.match(/<script\b[^>]*>/i);
  assert.ok(firstScript);
  assert.doesNotMatch(firstScript[0], /\bsrc=/i);
});

test("authored surface chrome uses only Kestral semantic color variables", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.match(css, /var\(--color-text\)/);
  assert.match(css, /var\(--color-focus-ring\)/);
});

test("current surface layout retains the responsive and reduced-motion guards", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /@media \(max-width: 48em\)/);
  assert.match(css, /@media \(max-width: 36em\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /min-height:\s*2rem/);
});

async function manifestFile() {
  return JSON.parse(await readFile(new URL("app.json", packageRoot), "utf8"));
}

async function packageFiles() {
  const root = new URL("../dist/", import.meta.url);
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, directory), relative);
      else files.push(relative);
    }
  }
  await visit(root);
  return files.sort();
}
