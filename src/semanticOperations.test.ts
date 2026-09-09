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

describe("strict semantic boundary", () => {
  it.each([
    { kind: "delete", id: "x", unexpected: true },
    { kind: "group", ids: [] },
    { kind: "group", ids: ["x", "x"] },
    { kind: "group", ids: ["x"] },
    { kind: "set-frame", ids: [], frame_id: null },
    { kind: "update", id: "x", patch: { text: 123 } },
    { kind: "update", id: "x", patch: { x: "12" } },
    { kind: "update", id: "x", patch: { width: -1 } },
    { kind: "update", id: "x", patch: { fillStyle: "unknown" } },
    { kind: "add", element: { type: "text", text: 123 } },
    { kind: "add", element: { type: "text", x: null } },
  ])("rejects malformed operation %# during parsing", (operation) => {
    expect(() => parseCanvasOperations([operation])).toThrow();
  });

  it("preserves every polyline point when resizing", () => {
    const scene = createScene([{ type: "line", id: "line", width: 100, height: 60 }]);
    scene.elements[0].points = [[0, 0], [50, 20], [100, 60]];
    const result = applyCanvasOperations(scene, parseCanvasOperations([{ kind: "update", id: "line", patch: { width: 200, height: 120 } }]));
    expect(result.scene.elements[0].points).toEqual([[0, 0], [100, 40], [200, 120]]);
    expect(scene.elements[0].points).toEqual([[0, 0], [50, 20], [100, 60]]);
  });
});
