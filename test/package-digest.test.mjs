import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("package digest matches Kestral host framing", async () => {
  const packageRoot = new URL("../dist/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("app.json", packageRoot), "utf8"));
  const hash = createHash("sha256");
  for (const path of ["app.json", ...Object.keys(manifest.integrity.assets)].sort()) {
    const pathBytes = Buffer.from(path, "utf8");
    const bytes = await readFile(new URL(path, packageRoot));
    const pathLength = Buffer.alloc(8);
    const bodyLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(pathBytes.byteLength));
    bodyLength.writeBigUInt64LE(BigInt(bytes.byteLength));
    hash.update(pathLength).update(pathBytes).update(bodyLength).update(bytes);
  }
  const expected = `sha256-${hash.digest("hex")}`;
  const result = spawnSync(process.execPath, ["scripts/package-digest.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
});
