import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function packageDigest(packageDir) {
  const manifest = JSON.parse(await readFile(join(packageDir, "app.json"), "utf8"));
  const assets = manifest.integrity?.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error("app.json must declare integrity.assets");
  }

  const paths = ["app.json", ...Object.keys(assets)].sort();
  if (new Set(paths).size !== paths.length) {
    throw new Error("integrity.assets must not redeclare app.json");
  }
  const hash = createHash("sha256");
  for (const path of paths) {
    if (path !== "app.json" && (!/^(ui|backend)\/[^/]+(?:\/[^/]+)*$/.test(path) || path.split("/").some((part) => part === "." || part === ".."))) {
      throw new Error(`unsafe package path: ${path}`);
    }
    const bytes = await readFile(join(packageDir, ...path.split("/")));
    const pathBytes = Buffer.from(path, "utf8");
    const pathLength = Buffer.alloc(8);
    const bodyLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(pathBytes.byteLength));
    bodyLength.writeBigUInt64LE(BigInt(bytes.byteLength));
    hash.update(pathLength).update(pathBytes).update(bodyLength).update(bytes);
  }

  return `sha256-${hash.digest("hex")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  console.log(await packageDigest(resolve(root, process.argv[2] ?? "dist")));
}
