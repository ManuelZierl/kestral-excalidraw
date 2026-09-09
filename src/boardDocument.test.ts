import { describe, expect, it, vi } from "vitest";
import { parseBoardDocument } from "./boardDocument";
import { testElement } from "./test/fakeDataV2";

vi.mock("@excalidraw/excalidraw", () => ({ serializeAsJSON: vi.fn() }));

const board = (elements: unknown[]) => ({ type: "kestral-excalidraw", version: 1, editor: "excalidraw", elements, appState: {}, files: {} });

describe("saved scene boundary", () => {
  it.each([
    [null],
    [testElement("duplicate"), testElement("duplicate")],
    [{ ...testElement("bad"), x: "zero" }],
    [{ ...testElement("bad"), width: -1 }],
    [{ ...testElement("bad"), y: Infinity }],
    [{ ...testElement("bad"), type: "text", text: 123 }],
    [{ ...testElement("bad"), type: "line", points: [[0, null]] }],
  ])("rejects unsafe scene shape %# before rendering or summarizing", (...elements) => {
    expect(() => parseBoardDocument(board(elements))).toThrow(/element/i);
  });

  it("preserves native Excalidraw fields and assets while stripping viewport state", () => {
    const element = { ...testElement("image"), type: "image", fileId: "asset", customData: { note: "kept" } };
    const value = { ...board([element]), appState: { scrollX: 12, scrollY: 3, zoom: { value: 2 }, viewBackgroundColor: "#fff" }, files: { asset: { id: "asset", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 } } };
    expect(parseBoardDocument(value)).toEqual({ ...value, appState: { viewBackgroundColor: "#fff" } });
  });
});
