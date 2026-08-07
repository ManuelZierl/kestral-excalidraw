import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function build() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function digest() {
  const result = spawnSync(process.execPath, ["scripts/package-digest.mjs"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

build();
const first = digest();
build();
const second = digest();
assert.match(first, /^sha256-[0-9a-f]{64}$/);
assert.equal(second, first, "two clean builds must produce identical Kestral package digests");
console.log(`Reproducible package checksum: ${first}`);
