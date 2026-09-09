import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawProps } from "@excalidraw/excalidraw/types";

export const BOARD_DOCUMENT_TYPE = "kestral-excalidraw";
export const BOARD_DOCUMENT_VERSION = 1;

export type SceneElements = Parameters<NonNullable<ExcalidrawProps["onChange"]>>[0];

export interface BoardDocument {
  type: typeof BOARD_DOCUMENT_TYPE;
  version: typeof BOARD_DOCUMENT_VERSION;
  editor: "excalidraw";
  elements: SceneElements;
  appState: Partial<AppState>;
  files: BinaryFiles;
}

export function createBoardDocument(
  elements: SceneElements,
  appState: AppState,
  files: BinaryFiles,
): BoardDocument {
  const exported = JSON.parse(serializeAsJSON(elements, appState, files, "local")) as unknown;
  if (!isRecord(exported) || !Array.isArray(exported.elements) || !isRecord(exported.appState)) {
    throw new Error("Excalidraw returned an invalid serialized scene.");
  }
  return {
    type: BOARD_DOCUMENT_TYPE,
    version: BOARD_DOCUMENT_VERSION,
    editor: "excalidraw",
    elements: exported.elements as unknown as SceneElements,
    appState: withoutViewport(exported.appState as Partial<AppState>),
    files: isRecord(exported.files) ? (exported.files as BinaryFiles) : {},
  };
}

export function parseBoardDocument(value: unknown): BoardDocument {
  if (!isRecord(value)) {
    throw new Error("Saved board is not an object.");
  }
  if (value.type !== BOARD_DOCUMENT_TYPE || value.version !== BOARD_DOCUMENT_VERSION) {
    throw new Error("Saved board uses an unsupported document format.");
  }
  if (value.editor !== "excalidraw" || !Array.isArray(value.elements)) {
    throw new Error("Saved board does not contain a valid Excalidraw scene.");
  }
  if (!isRecord(value.appState) || !isRecord(value.files)) {
    throw new Error("Saved board is missing Excalidraw state or files.");
  }
  // Check the fields consumed by our summary/semantic layer before handing the
  // opaque scene to Excalidraw. Preserve native fields rather than narrowing a
  // freehand/image scene to the smaller semantic proposal vocabulary.
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id || ids.has(element.id) ||
        typeof element.type !== "string" || !element.type ||
        ![element.x, element.y, element.width, element.height].every(finiteNumber) ||
        (element.width as number) < 0 || (element.height as number) < 0 ||
        ("isDeleted" in element && typeof element.isDeleted !== "boolean") ||
        ("text" in element && typeof element.text !== "string") ||
        ("points" in element && (!Array.isArray(element.points) || !element.points.every((point) =>
          Array.isArray(point) && point.length === 2 && point.every(finiteNumber))))) {
      throw new Error("Saved board contains an invalid or duplicate element.");
    }
    ids.add(element.id);
  }
  return {
    ...(value as unknown as BoardDocument),
    appState: withoutViewport(value.appState as Partial<AppState>),
  };
}

function withoutViewport(appState: Partial<AppState>): Partial<AppState> {
  const { scrollX: _scrollX, scrollY: _scrollY, zoom: _zoom, ...durableState } = appState;
  return durableState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
