import { describe, expect, it } from "vitest";
import { validateProposalArtifact } from "./proposals";

const appId = "com.ma-zierl.kestral-excalidraw";
const documentId = "00000000-0000-4000-8000-000000000001";

describe("canvas proposal validation", () => {
  it("accepts the host artifact envelope and frontend semantic payload", () => {
    const proposal = validateProposalArtifact(artifact(), appId, "canvases");
    expect(proposal.targetId).toBe(documentId);
    expect(proposal.operations).toHaveLength(1);
  });

  it("rejects undeclared envelope and payload fields", () => {
    expect(() => validateProposalArtifact({ ...artifact(), content: { ...artifact().content, extra: true } }, appId, "canvases")).toThrow();
    expect(() => validateProposalArtifact({ ...artifact(), content: { ...artifact().content, payload: { ...artifact().content.payload, extra: true } } }, appId, "canvases")).toThrow();
  });

  it("refuses malformed, foreign, and replay-shaped proposal envelopes", () => {
    expect(() => validateProposalArtifact({ ...artifact(), content: { ...artifact().content as object, targetAppId: "other.app" } }, appId, "canvases")).toThrow(/target|revision/i);
    expect(() => validateProposalArtifact({ ...artifact(), content: { ...artifact().content as object, resourceId: "app-data:com.ma-zierl.kestral-excalidraw:canvases:document:not-a-uuid" } }, appId, "canvases")).toThrow(/resource/i);
    expect(() => validateProposalArtifact({ ...artifact(), content: { ...artifact().content as object, payload: { operations: [{ kind: "update", id: "x", patch: { unsupported: true } }] } } }, appId, "canvases")).toThrow(/unsupported|patch/i);
  });
});

function artifact() {
  return {
    artifact_id: "proposal-1",
    artifact_type: "canvas-operations-proposal",
    title: "Add text",
    content: {
      targetAppId: appId,
      targetKind: "document",
      collection: "canvases",
      resourceId: `app-data:${appId}:canvases:document:${documentId}`,
      targetGeneration: 3,
      targetRevision: 1,
      payload: { operations: [{ kind: "add", element: { type: "text", id: "text-1", text: "Hello" } }] },
    },
  };
}
