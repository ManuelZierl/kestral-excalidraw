import { parseCanvasOperations } from "./semanticOperations";
import type { CanvasOperation } from "./semanticTypes";

export const PROPOSAL_CAPABILITY = "propose-canvas-operations";
export const PROPOSAL_ARTIFACT_TYPE = "canvas-operations-proposal";
export const MAX_PROPOSAL_PAYLOAD_BYTES = 16 * 1024;
export const PROPOSAL_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "element"], properties: { kind: { const: "add" }, element: semanticElementSchema() } },
          { type: "object", additionalProperties: false, required: ["kind", "id", "patch"], properties: { kind: { const: "update" }, id: idSchema(), patch: patchSchema() } },
          { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { enum: ["delete", "restore"] }, id: idSchema() } },
          { type: "object", additionalProperties: false, required: ["kind", "ids"], properties: { kind: { enum: ["group"] }, ids: idsSchema(2) } },
          { type: "object", additionalProperties: false, required: ["kind", "group_id"], properties: { kind: { const: "ungroup" }, group_id: idSchema() } },
          { type: "object", additionalProperties: false, required: ["kind", "ids", "frame_id"], properties: { kind: { const: "set-frame" }, ids: idsSchema(1), frame_id: { anyOf: [idSchema(), { type: "null" }] } } },
          { type: "object", additionalProperties: false, required: ["kind", "ids", "anchor_id", "position"], properties: { kind: { const: "reorder" }, ids: idsSchema(1), anchor_id: idSchema(), position: { enum: ["before", "after"] } } },
        ],
      },
    },
  },
} as const;

export interface ProposalArtifact {
  artifact_id: string;
  artifact_type: string;
  title: string;
  content: unknown;
}

export interface CanvasProposal {
  artifactId: string;
  title: string;
  targetId: string;
  targetGeneration: number;
  targetRevision: number;
  operations: CanvasOperation[];
}

export function validateProposalArtifact(artifact: ProposalArtifact, appId: string, collection: string): CanvasProposal {
  if (typeof artifact.artifact_id !== "string" || artifact.artifact_id.length === 0 || typeof artifact.title !== "string" || artifact.artifact_type !== PROPOSAL_ARTIFACT_TYPE || !isObject(artifact.content)) throw new Error("This artifact is not a canvas operations proposal.");
  const content = artifact.content;
  if (content.targetAppId !== appId || content.targetKind !== "document" || content.collection !== collection ||
    typeof content.resourceId !== "string" || typeof content.targetGeneration !== "number" || !Number.isSafeInteger(content.targetGeneration) || content.targetGeneration < 0 ||
    typeof content.targetRevision !== "number" || !Number.isSafeInteger(content.targetRevision) || content.targetRevision < 1 ||
    !isObject(content.payload) || !Array.isArray(content.payload.operations)) {
    throw new Error("Proposal target or revision envelope is invalid.");
  }
  const envelopeKeys = ["targetAppId", "targetKind", "collection", "resourceId", "targetGeneration", "targetRevision", "payload"];
  if (Object.keys(content).length !== envelopeKeys.length || envelopeKeys.some((key) => !Object.hasOwn(content, key)) ||
      Object.keys(content.payload).length !== 1 || !Object.hasOwn(content.payload, "operations")) {
    throw new Error("Proposal envelope or payload contains unsupported fields.");
  }
  const resourcePrefix = `app-data:${appId}:${collection}:document:`;
  const targetPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!content.resourceId.startsWith(resourcePrefix) || !targetPattern.test(content.resourceId.slice(resourcePrefix.length))) {
    throw new Error("Proposal resource identity is invalid.");
  }
  const targetId = content.resourceId.slice(resourcePrefix.length);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(content.payload));
  if (payloadBytes.byteLength > MAX_PROPOSAL_PAYLOAD_BYTES) throw new Error("Proposal payload exceeds the local bound.");
  const operations = parseCanvasOperations(content.payload.operations);
  return {
    artifactId: artifact.artifact_id,
    title: artifact.title,
    targetId,
    targetGeneration: content.targetGeneration,
    targetRevision: content.targetRevision,
    operations,
  };
}

function idSchema() { return { type: "string", minLength: 1, maxLength: 512 }; }
function idsSchema(minItems: number) { return { type: "array", minItems, maxItems: 100, uniqueItems: true, items: idSchema() }; }
function semanticElementSchema() {
  return {
    type: "object", additionalProperties: false, required: ["type"],
    properties: {
      type: { enum: ["text", "rectangle", "ellipse", "diamond", "line", "arrow", "frame"] }, id: idSchema(),
      x: numberSchema(-1000000, 1000000), y: numberSchema(-1000000, 1000000), width: numberSchema(0, 1000000), height: numberSchema(0, 1000000), angle: numberSchema(-360, 360),
      text: { type: "string", maxLength: 2000 }, strokeColor: colorSchema(), backgroundColor: colorSchema(true), fillStyle: { enum: ["solid", "hachure", "cross-hatch"] }, strokeWidth: numberSchema(1, 100), roughness: numberSchema(0, 100), opacity: numberSchema(0, 100), strokeStyle: { enum: ["solid", "dashed", "dotted"] }, fontSize: numberSchema(8, 256), fontFamily: numberSchema(1, 10), textAlign: { enum: ["left", "center", "right"] }, verticalAlign: { enum: ["top", "middle", "bottom"] }, locked: { type: "boolean" },
    },
  };
}
function patchSchema() { const schema = semanticElementSchema(); const { type: _type, id: _id, ...properties } = schema.properties; return { type: "object", additionalProperties: false, properties }; }
function numberSchema(min: number, max: number) { return { type: "number", minimum: min, maximum: max }; }
function colorSchema(transparent = false) { return transparent ? { anyOf: [{ const: "transparent" }, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }] } : { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }; }
function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
