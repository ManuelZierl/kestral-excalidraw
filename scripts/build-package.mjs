import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const [html, appLicense, notices] = await Promise.all([
  readFile(join(distDir, "ui", "index.html")),
  readFile(join(root, "LICENSE")),
  readFile(join(root, "THIRD-PARTY-NOTICES.txt")),
]);
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const appId = "com.ma-zierl.kestral-excalidraw";
const proposalCapability = "propose-canvas-operations";
const proposalArtifactType = "canvas-operations-proposal";
const proposalPayloadSchema = semanticProposalPayloadSchema();
const proposalInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetId", "targetRevision", "payload"],
  properties: {
    targetId: { type: "string", pattern: uuidPattern(), "x-kestral-managed-data-scope": { kind: "document", collection: "canvases" } },
    targetRevision: { type: "integer", minimum: 1 },
    payload: proposalPayloadSchema,
  },
  "x-kestral-managed-data-proposal": true,
};
const proposalArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetAppId", "targetKind", "collection", "resourceId", "targetGeneration", "targetRevision", "payload"],
  properties: {
    targetAppId: { const: appId },
    targetKind: { const: "document" },
    collection: { const: "canvases" },
    resourceId: { type: "string", minLength: 1, maxLength: 256 },
    targetGeneration: { type: "integer", minimum: 0 },
    targetRevision: { type: ["integer", "null"], minimum: 1 },
    payload: proposalPayloadSchema,
  },
};

const manifest = {
  format_version: 1,
  id: appId,
  version: packageMetadata.version,
  display_name: "Whiteboard",
  description: "A local multi-canvas Excalidraw whiteboard backed by Kestral managed documents.",
  license: "MIT",
  icon: { kind: "kestral", name: "pencil-ruler" },
  min_host_version: "0.1.0-alpha.1",
  manifest: {
    capabilities: [{ name: proposalCapability, description: "Propose bounded semantic canvas operations for review in the Whiteboard.", input_schema: proposalInputSchema, output_schema: proposalArtifactSchema, effect: "local-write" }],
    artifact_types: [{ name: proposalArtifactType, description: "A reviewable semantic canvas operation proposal.", json_schema: proposalArtifactSchema }],
    surfaces: [{ name: "whiteboard", kind: "dashboard", title: "Whiteboard", description: "An infinite canvas for sketches, diagrams, and visual thinking.", intents: [{ provider: appId, capability: proposalCapability }], ui: { entry: "ui/index.html" } }],
    grant_requests: [],
  },
  consumer_grant_requests: [{
    holder: "chat",
    request: {
      scope: { kind: "exact-capability", provider: appId, capability: proposalCapability },
      data_scope: { kind: "all-resources" },
      condition: "requires-approval",
      reason: "Let Chat create reviewable semantic Whiteboard proposals for your approval.",
      duration: { kind: "non-expiring" },
    },
  }],
  backend: { kind: "none" },
  data: {
    kind: "host-managed",
    contract_version: 2,
    collections: {},
    documents: {
      canvases: {
        metadata_schema: canvasMetadataSchema(),
        operations: ["get", "list", "create", "replace", "update-metadata", "delete"],
        limits: { documents: 10000, metadata_bytes: 65536, content_bytes: 8388608 },
      },
    },
    limits: { total_bytes: 67108864, transaction_operations: 64, batch_operations: 2048 },
    exports: [],
    proposals: [{ capability: proposalCapability, artifact_type: proposalArtifactType, title: "Propose canvas operations", description: "Create a reviewable bounded semantic canvas change.", target: { kind: "document", document_collection: "canvases" }, payload_schema: proposalPayloadSchema, max_payload_bytes: 16384 }],
  },
  integrity: {
    algorithm: "sha256",
    assets: {
      "ui/index.html": digest(html),
      "ui/LICENSE": digest(appLicense),
      "ui/THIRD-PARTY-NOTICES.txt": digest(notices),
    },
  },
};

await writeFile(join(distDir, "ui", "LICENSE"), appLicense);
await writeFile(join(distDir, "ui", "THIRD-PARTY-NOTICES.txt"), notices);
await writeFile(join(distDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Built backend-free Kestral Excalidraw package in ${distDir}`);

function canvasMetadataSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["schema_version", "title", "trashed_at", "summary", "searchable_text", "applied_proposals"],
    properties: {
      schema_version: { const: 2 }, title: { type: "string", minLength: 1, maxLength: 120 }, trashed_at: { type: ["string", "null"] },
      summary: { type: "object", additionalProperties: false, required: ["element_count", "element_count_by_type", "deleted_count", "bounds", "text_snippets"], properties: { element_count: { type: "integer", minimum: 0 }, element_count_by_type: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, deleted_count: { type: "integer", minimum: 0 }, bounds: { type: ["object", "null"] }, text_snippets: { type: "array", maxItems: 5, items: { type: "string", maxLength: 120 } } } },
      searchable_text: { type: "string", maxLength: 4096 }, applied_proposals: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["proposal_id", "status", "target_revision"], properties: { proposal_id: { type: "string", minLength: 1, maxLength: 256 }, status: { enum: ["applied", "rejected"] }, target_revision: { type: "integer", minimum: 1 } } } },
    },
  };
}

function semanticProposalPayloadSchema() {
  const id = { type: "string", minLength: 1, maxLength: 512 };
  const number = (minimum, maximum) => ({ type: "number", minimum, maximum });
  const color = (transparent = false) => transparent ? { anyOf: [{ const: "transparent" }, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }] } : { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
  const element = { type: "object", additionalProperties: false, required: ["type"], properties: { type: { enum: ["text", "rectangle", "ellipse", "diamond", "line", "arrow", "frame"] }, id, x: number(-1000000, 1000000), y: number(-1000000, 1000000), width: number(0, 1000000), height: number(0, 1000000), angle: number(-360, 360), text: { type: "string", maxLength: 2000 }, strokeColor: color(), backgroundColor: color(true), fillStyle: { enum: ["solid", "hachure", "cross-hatch"] }, strokeWidth: number(1, 100), roughness: number(0, 100), opacity: number(0, 100), strokeStyle: { enum: ["solid", "dashed", "dotted"] }, fontSize: number(8, 256), fontFamily: number(1, 10), textAlign: { enum: ["left", "center", "right"] }, verticalAlign: { enum: ["top", "middle", "bottom"] }, locked: { type: "boolean" } } };
  const patch = { ...element, required: [], properties: Object.fromEntries(Object.entries(element.properties).filter(([key]) => key !== "type" && key !== "id")) };
  const ids = (minimum) => ({ type: "array", minItems: minimum, maxItems: 100, uniqueItems: true, items: id });
  return { type: "object", additionalProperties: false, required: ["operations"], properties: { operations: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "element"], properties: { kind: { const: "add" }, element } },
    { type: "object", additionalProperties: false, required: ["kind", "id", "patch"], properties: { kind: { const: "update" }, id, patch } },
    { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { enum: ["delete", "restore"] }, id } },
    { type: "object", additionalProperties: false, required: ["kind", "ids"], properties: { kind: { const: "group" }, ids: ids(2) } },
    { type: "object", additionalProperties: false, required: ["kind", "group_id"], properties: { kind: { const: "ungroup" }, group_id: id } },
    { type: "object", additionalProperties: false, required: ["kind", "ids", "frame_id"], properties: { kind: { const: "set-frame" }, ids: ids(1), frame_id: { type: ["string", "null"] } } },
    { type: "object", additionalProperties: false, required: ["kind", "ids", "anchor_id", "position"], properties: { kind: { const: "reorder" }, ids: ids(1), anchor_id: id, position: { enum: ["before", "after"] } } },
  ] } } } };
}
function uuidPattern() { return "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"; }
function digest(bytes) { return `sha256-${createHash("sha256").update(bytes).digest("hex")}`; }
