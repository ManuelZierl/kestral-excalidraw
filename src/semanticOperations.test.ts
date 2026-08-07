import { describe, expect, it } from "vitest";
import { applyCanvasOperations, createScene, parseCanvasOperations } from "./semanticOperations";

describe("frontend semantic canvas operations", () => {
  it("validates and applies add, group, frame, reorder, update, delete, and restore", () => {
    const scene = createScene([
      { type: "text", id: "text", text: "Before" },
      { type: "rectangle", id: "rect" },
      { type: "frame", id: "frame", text: "Section" },
    ]);
    const result = applyCanvasOperations(scene, parseCanvasOperations([
      { kind: "group", ids: ["text", "rect"] },
      { kind: "set-frame", ids: ["text", "rect"], frame_id: "frame" },
      { kind: "reorder", ids: ["frame"], anchor_id: "text", position: "before" },
      { kind: "update", id: "text", patch: { text: "After" } },
      { kind: "delete", id: "rect" },
      { kind: "restore", id: "rect" },
    ]));

    expect(result.scene.elements[0].id).toBe("frame");
    expect(result.scene.elements.find((element) => element.id === "text")?.text).toBe("After");
    expect(result.scene.elements.find((element) => element.id === "text")?.frameId).toBe("frame");
    expect(result.changes.updated_element_ids).toContain("text");
  });

  it("rejects one invalid operation before any mutation is persisted", () => {
    const scene = createScene([{ type: "text", id: "text", text: "Before" }]);
    expect(() => applyCanvasOperations(scene, parseCanvasOperations([
      { kind: "update", id: "text", patch: { text: "After" } },
      { kind: "update", id: "missing", patch: { text: "never" } },
    ]))).toThrow(/missing/);
    expect(scene.elements[0].text).toBe("Before");
  });
});
