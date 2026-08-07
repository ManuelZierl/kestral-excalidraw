import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, process.argv[2] ?? "THIRD-PARTY-NOTICES.txt");
const licenseFilePattern = /^(licen[cs]e|copying|notice|copyright)(\..*)?$/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function repositoryUrl(repository) {
  if (typeof repository === "string") return repository;
  return repository?.url ?? "not declared";
}

function licenseFiles(packageDirectory, declaredLicenseFile) {
  const candidates = new Set();
  if (declaredLicenseFile) candidates.add(resolve(packageDirectory, declaredLicenseFile));
  for (const name of readdirSync(packageDirectory)) {
    const path = join(packageDirectory, name);
    if (licenseFilePattern.test(name) && statSync(path).isFile()) candidates.add(path);
  }
  return [...candidates]
    .filter(existsSync)
    .sort(compareText)
    .map((path) => ({
      name: relative(packageDirectory, path).replaceAll("\\", "/"),
      text: normalize(readFileSync(path, "utf8")),
    }))
    .filter(({ text }) => text.length > 0);
}

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packagesById = new Map();
for (const [packagePath, lockEntry] of Object.entries(lock.packages)) {
  if (!packagePath.includes("node_modules/") || lockEntry.link || lockEntry.dev) continue;
  const packageDirectory = join(root, packagePath);
  if (!existsSync(packageDirectory)) {
    if (lockEntry.optional) continue;
    throw new Error(`Installed production dependency is missing: ${packagePath}`);
  }
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const legacyLicenses = Array.isArray(manifest.licenses)
    ? manifest.licenses.map((entry) => typeof entry === "string" ? entry : entry?.type).filter(Boolean)
    : [];
  const license = typeof manifest.license === "string"
    ? manifest.license
    : typeof lockEntry.license === "string"
      ? lockEntry.license
      : legacyLicenses.join(" OR ");
  const files = licenseFiles(packageDirectory, manifest.licenseFile);
  if (!license && files.length === 0) {
    throw new Error(`Missing npm license metadata and files: ${manifest.name}@${manifest.version}`);
  }
  const dependency = {
    name: manifest.name,
    version: manifest.version,
    license: license || "SEE BUNDLED LICENSE FILE",
    source: repositoryUrl(manifest.repository),
    files,
  };
  const id = `${dependency.name}@${dependency.version}`;
  const existing = packagesById.get(id);
  if (!existing || dependency.files.length > existing.files.length) packagesById.set(id, dependency);
}

const dependencies = [...packagesById.values()].sort((left, right) =>
  compareText(`${left.name}@${left.version}`, `${right.name}@${right.version}`),
);
const textsByHash = new Map();
for (const dependency of dependencies) {
  for (const file of dependency.files) {
    const hash = createHash("sha256").update(file.text).digest("hex");
    const entry = textsByHash.get(hash) ?? { text: file.text, packages: [] };
    entry.packages.push(`${dependency.name}@${dependency.version} (${file.name})`);
    textsByHash.set(hash, entry);
  }
}

const lines = [
  "KESTRAL EXCALIDRAW THIRD-PARTY NOTICES",
  "=======================================",
  "",
  "Generated from the locked, installed production dependency tree. Package",
  "license metadata is listed for every dependency; distributed license and",
  "notice files are reproduced below. This file is informational and does not",
  "replace the licenses that govern the corresponding software.",
  "",
  "DEPENDENCY INVENTORY",
  "--------------------",
];

for (const dependency of dependencies) {
  lines.push(
    "",
    `${dependency.name}@${dependency.version}`,
    `License: ${dependency.license}`,
    `Source metadata: ${dependency.source}`,
    `Bundled license files: ${dependency.files.map(({ name }) => name).join(", ") || "none distributed in package"}`,
  );
}

lines.push("", "LICENSE AND NOTICE TEXTS", "------------------------");
for (const [hash, entry] of [...textsByHash.entries()].sort(([left], [right]) => compareText(left, right))) {
  lines.push("", `SHA-256: ${hash}`, "Used by:");
  for (const packageName of entry.packages.sort(compareText)) lines.push(`- ${packageName}`);
  lines.push("", entry.text);
}

writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${relative(root, outputPath)} for ${dependencies.length} dependencies and ${textsByHash.size} unique texts.`);
