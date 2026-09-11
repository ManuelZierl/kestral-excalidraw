import type {
  CanvasOperation,
  JsonObject,
  OperationChanges,
  SceneDocument,
  SemanticElementInput,
  SemanticUpdatePatch,
} from "./semanticTypes";

const allowedKinds = new Set(["text", "rectangle", "ellipse", "diamond", "line", "arrow", "frame"]);
const allowedPatchKeys = new Set(["x", "y", "width", "height", "angle", "text", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "roughness", "opacity", "strokeStyle", "fontSize", "fontFamily", "textAlign", "verticalAlign", "locked"]);
const allowedElementKeys = new Set(["type", "id", ...allowedPatchKeys]);

export function createScene(elements: SemanticElementInput[] = []): SceneDocument {
  const normalized = elements.map(normalizeSemanticElement);
  assertUniqueIds(normalized);
  return {
    type: "kestral-excalidraw",
    version: 1,
    editor: "excalidraw",
    elements: normalized,
    appState: {},
    files: {},
  };
}

export function cloneScene(scene: SceneDocument): SceneDocument {
  return structuredClone(scene);
}

export function applyCanvasOperations(scene: SceneDocument, operations: CanvasOperation[]): {
  scene: SceneDocument;
  changes: OperationChanges;
} {
  const next = cloneScene(scene);
  const changes: OperationChanges = {
    created_element_ids: [],
    created_group_ids: [],
    updated_element_ids: [],
    deleted_element_ids: [],
    restored_element_ids: [],
  };
  for (const operation of operations) applyOperation(next, operation, changes);
  changes.updated_element_ids = [...new Set(changes.updated_element_ids)];
  return { scene: next, changes };
}

export function parseCanvasOperations(value: unknown): CanvasOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("operations must be a non-empty array of at most 100 items");
  }
  const operations = value.map((operation) => parseOperation(operation));
  const referencedIds = operations.flatMap((operation) => {
    switch (operation.kind) {
      case "add":
        return operation.element.id ? [operation.element.id] : [];
      case "update":
      case "delete":
      case "restore":
        return [operation.id];
      case "group":
        return operation.ids;
      case "set-frame":
        return [...operation.ids, ...(operation.frame_id === null ? [] : [operation.frame_id])];
      case "ungroup":
        return [];
      case "reorder":
        return [...operation.ids, operation.anchor_id];
    }
  });
  if (new Set(referencedIds).size > 100) throw new Error("an operation batch may reference at most 100 elements");
  return operations;
}

export function normalizeSemanticElement(input: SemanticElementInput): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("element must be an object");
  for (const key of Object.keys(input)) {
    if (!allowedElementKeys.has(key)) throw new Error(`unsupported element field '${key}'`);
  }
  if (!allowedKinds.has(input.type)) throw new Error(`unsupported element type '${input.type}'`);
  const textStyleKeys = ["fontSize", "fontFamily", "textAlign", "verticalAlign"];
  if (input.type !== "text" && textStyleKeys.some((key) => key in input)) {
    throw new Error("text style fields may only be used with text elements");
  }
  if (input.type !== "text" && input.type !== "frame" && input.text !== undefined) {
    throw new Error("text may only be used with text or frame elements");
  }
  validatePatchValues(input);
  const id = input.id ?? globalThis.crypto.randomUUID();
  assertElementId(id);
  const base: JsonObject = {
    id,
    type: input.type,
    x: number(input.x ?? 0, -1e6, 1e6),
    y: number(input.y ?? 0, -1e6, 1e6),
    width: number(input.width ?? 160, 0, 1e6),
    height: number(input.height ?? 60, 0, 1e6),
    angle: number(input.angle ?? 0, -360, 360),
    strokeColor: color(input.strokeColor ?? "#1e1e1e"),
    backgroundColor: color(input.backgroundColor ?? "transparent"),
    fillStyle: input.fillStyle ?? "solid",
    strokeWidth: number(input.strokeWidth ?? 1, 1, 100),
    roughness: number(input.roughness ?? 0, 0, 100),
    opacity: number(input.opacity ?? 100, 0, 100),
    strokeStyle: input.strokeStyle ?? "solid",
    locked: Boolean(input.locked ?? false),
    groupIds: [],
    frameId: null,
    version: 1,
    versionNonce: nextNonce(),
    updated: Date.now(),
    isDeleted: false,
    seed: nextNonce(),
    index: null,
    boundElements: [],
    containerId: null,
    link: null,
  };
  if (input.type === "text") {
    const text = limitText(String(input.text ?? ""), 2000);
    const fontSize = number(input.fontSize ?? 20, 8, 256);
    return {
      ...base,
      text,
      originalText: text,
      fontSize,
      fontFamily: number(input.fontFamily ?? 1, 1, 10),
      textAlign: input.textAlign ?? "left",
      verticalAlign: input.verticalAlign ?? "top",
      baseline: fontSize,
      autoResize: true,
      lineHeight: 1.25,
    };
  }
  if (input.type === "line" || input.type === "arrow") {
    return {
      ...base,
      points: [[0, 0], [base.width as number, base.height as number]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: input.type === "arrow" ? "arrow" : null,
      ...(input.type === "arrow" ? { elbowed: false } : {}),
    };
  }
  if (input.type === "frame") {
    return { ...base, name: limitText(String(input.text ?? ""), 200) || null };
  }
  return { ...base, roundness: input.type === "rectangle" ? { type: 3 } : null };
}

function applyOperation(scene: SceneDocument, op: CanvasOperation, changes: OperationChanges): void {
  switch (op.kind) {
    case "add": {
      const id = addElement(scene, op.element);
      changes.created_element_ids.push(id);
      return;
    }
    case "update":
      updateElement(scene, op.id, op.patch);
      changes.updated_element_ids.push(op.id);
      return;
    case "delete":
      toggleDeleted(scene, op.id, true);
      changes.deleted_element_ids.push(op.id);
      return;
    case "restore":
      toggleDeleted(scene, op.id, false);
      changes.restored_element_ids.push(op.id);
      return;
    case "group": {
      const groupId = group(scene, op.ids);
      changes.created_group_ids.push(groupId);
      changes.updated_element_ids.push(...op.ids);
      return;
    }
    case "ungroup":
      changes.updated_element_ids.push(...ungroup(scene, op.group_id));
      return;
    case "set-frame":
      setFrame(scene, op.ids, op.frame_id);
      changes.updated_element_ids.push(...op.ids);
      return;
    case "reorder":
      reorder(scene, op.ids, op.anchor_id, op.position);
      changes.updated_element_ids.push(...op.ids);
      return;
  }
}

function updateElement(scene: SceneDocument, id: string, patch: SemanticUpdatePatch): void {
  const element = liveElement(scene, id);
  const previousWidth = Number(element.width);
  const previousHeight = Number(element.height);
  validatePatchValues(patch);
  for (const key of Object.keys(patch)) if (!allowedPatchKeys.has(key)) throw new Error(`unsupported patch field '${key}'`);
  const textStyleKeys = ["fontSize", "fontFamily", "textAlign", "verticalAlign"];
  if (element.type !== "text" && textStyleKeys.some((key) => key in patch)) {
    throw new Error("text style properties may only update text elements");
  }
  if (element.type !== "text" && element.type !== "frame" && patch.text !== undefined) {
    throw new Error("text may only update text or frame elements");
  }
  if (patch.text !== undefined) {
    if (element.type === "frame") {
      element.name = limitText(patch.text, 200) || null;
    } else {
      element.text = limitText(patch.text, 2000);
      element.originalText = element.text;
    }
  }
  if (patch.x !== undefined) element.x = number(patch.x, -1e6, 1e6);
  if (patch.y !== undefined) element.y = number(patch.y, -1e6, 1e6);
  if (patch.width !== undefined) element.width = number(patch.width, 0, 1e6);
  if (patch.height !== undefined) element.height = number(patch.height, 0, 1e6);
  if (patch.angle !== undefined) element.angle = number(patch.angle, -360, 360);
  if (patch.strokeColor !== undefined) element.strokeColor = color(patch.strokeColor);
  if (patch.backgroundColor !== undefined) element.backgroundColor = color(patch.backgroundColor);
  if (patch.fillStyle !== undefined) element.fillStyle = enumValue(patch.fillStyle, ["solid", "hachure", "cross-hatch"], "fillStyle");
  if (patch.strokeWidth !== undefined) element.strokeWidth = number(patch.strokeWidth, 1, 100);
  if (patch.roughness !== undefined) element.roughness = number(patch.roughness, 0, 100);
  if (patch.opacity !== undefined) element.opacity = number(patch.opacity, 0, 100);
  if (patch.strokeStyle !== undefined) element.strokeStyle = enumValue(patch.strokeStyle, ["solid", "dashed", "dotted"], "strokeStyle");
  if (patch.fontSize !== undefined) element.fontSize = number(patch.fontSize, 8, 256);
  if (patch.fontFamily !== undefined) element.fontFamily = number(patch.fontFamily, 1, 10);
  if (patch.textAlign !== undefined) element.textAlign = enumValue(patch.textAlign, ["left", "center", "right"], "textAlign");
  if (patch.verticalAlign !== undefined) element.verticalAlign = enumValue(patch.verticalAlign, ["top", "middle", "bottom"], "verticalAlign");
  if (patch.locked !== undefined) {
    if (typeof patch.locked !== "boolean") throw new Error("locked must be a boolean");
    element.locked = patch.locked;
  }
  if ((element.type === "line" || element.type === "arrow") && (patch.width !== undefined || patch.height !== undefined)) {
    const points = Array.isArray(element.points) ? element.points : [];
    const scale = (previous: number, next: number) => {
      if (previous === 0 && next !== 0) throw new Error("Cannot expand a zero-size polyline axis with semantic resizing.");
      return previous === 0 ? 1 : next / previous;
    };
    const scaleX = scale(previousWidth, Number(element.width));
    const scaleY = scale(previousHeight, Number(element.height));
    element.points = points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Cannot resize a polyline with invalid points.");
      }
      return [point[0] * scaleX, point[1] * scaleY];
    });
  }
  bump(element);
}

function toggleDeleted(scene: SceneDocument, id: string, deleted: boolean): void {
  const element = findElement(scene, id);
  if (Boolean(element.isDeleted) === deleted) {
    throw new Error(deleted ? "element is already deleted" : "element is not deleted");
  }
  element.isDeleted = deleted;
  bump(element);
  if (deleted && element.type === "frame") {
    for (const child of scene.elements) {
      if (child.frameId !== id) continue;
      child.frameId = null;
      bump(child);
    }
  }
}

function group(scene: SceneDocument, ids: string[]): string {
  assertUniqueSelection(ids, 2);
  const groupId = globalThis.crypto.randomUUID();
  for (const id of ids) {
    const element = liveElement(scene, id);
    element.groupIds = [...(Array.isArray(element.groupIds) ? element.groupIds : []), groupId];
    bump(element);
  }
  return groupId;
}

function ungroup(scene: SceneDocument, groupId: string): string[] {
  const changed: string[] = [];
  for (const element of scene.elements) {
    if (!Array.isArray(element.groupIds) || element.groupIds.at(-1) !== groupId) continue;
    element.groupIds = element.groupIds.slice(0, -1);
    bump(element);
    changed.push(String(element.id));
  }
  if (changed.length === 0) throw new Error("group not found");
  return changed;
}

function setFrame(scene: SceneDocument, ids: string[], frameId: string | null): void {
  assertUniqueSelection(ids, 1);
  if (frameId !== null) {
    const frame = liveElement(scene, frameId);
    if (frame.type !== "frame") throw new Error("frame target must be a frame");
  }
  for (const id of ids) {
    const element = liveElement(scene, id);
    if (frameId !== null && id === frameId) throw new Error("frame cycle detected");
    if (element.type === "frame") throw new Error("nested frames are not supported by semantic editing");
    element.frameId = frameId;
    bump(element);
  }
}

function reorder(scene: SceneDocument, ids: string[], anchorId: string, position: "before" | "after"): void {
  assertUniqueSelection(ids, 1);
  if (ids.includes(anchorId)) throw new Error("anchor cannot be selected");
  const selected = ids.map((id) => liveElement(scene, id));
  liveElement(scene, anchorId);
  const remaining = scene.elements.filter((element) => !ids.includes(String(element.id)));
  const anchorIndex = remaining.findIndex((element) => element.id === anchorId);
  const insertAt = position === "before" ? anchorIndex : anchorIndex + 1;
  scene.elements = [...remaining.slice(0, insertAt), ...selected, ...remaining.slice(insertAt)];
  for (const element of selected) {
    element.index = null;
    bump(element);
  }
}

function liveElement(scene: SceneDocument, id: string): JsonObject {
  const element = findElement(scene, id);
  if (element.isDeleted) throw new Error(`element '${id}' not found`);
  return element;
}

function findElement(scene: SceneDocument, id: string): JsonObject {
  const element = scene.elements.find((item) => item.id === id);
  if (!element) throw new Error(`element '${id}' not found`);
  return element;
}

function bump(element: JsonObject): void {
  element.version = number(Number(element.version ?? 1), 1, 1e9) + 1;
  element.versionNonce = nextNonce();
  element.updated = Date.now();
}

function elementId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("element id must be a non-empty string of at most 512 characters");
  }
  return value;
}

function assertElementId(id: string): void {
  elementId(id);
}

function color(value: string): string {
  if (value === "transparent") return value;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`invalid color '${value}'`);
  return value.toLowerCase();
}

function number(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error("numeric field must be finite");
  if (value < min || value > max) throw new Error(`numeric field out of range ${min}..${max}`);
  return value;
}

function limitText(text: string, max: number): string {
  if (text.length > max) throw new Error("text too long");
  return text;
}

function nextNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

const numericRanges: Record<string, readonly [number, number]> = {
  x: [-1e6, 1e6], y: [-1e6, 1e6], width: [0, 1e6], height: [0, 1e6], angle: [-360, 360],
  strokeWidth: [1, 100], roughness: [0, 100], opacity: [0, 100], fontSize: [8, 256], fontFamily: [1, 10],
};

function validatePatchValues(input: SemanticUpdatePatch): void {
  for (const [key, value] of Object.entries(input)) {
    const range = Object.hasOwn(numericRanges, key) ? numericRanges[key] : undefined;
    if (range) {
      if (typeof value !== "number") throw new Error(`${key} must be a number`);
      number(value, range[0], range[1]);
    } else if (key === "text") {
      if (typeof value !== "string") throw new Error("text must be a string");
      limitText(value, 2000);
    } else if (key === "strokeColor" || key === "backgroundColor") {
      if (typeof value !== "string" || (key === "strokeColor" && value === "transparent")) throw new Error(`invalid ${key}`);
      color(value);
    } else if (value === null || value === undefined) {
      throw new Error(`${key} must not be null or undefined`);
    }
  }
  validateStyleEnums(input);
}

function validateStyleEnums(input: SemanticUpdatePatch): void {
  if (input.fillStyle !== undefined) enumValue(input.fillStyle, ["solid", "hachure", "cross-hatch"], "fillStyle");
  if (input.strokeStyle !== undefined) enumValue(input.strokeStyle, ["solid", "dashed", "dotted"], "strokeStyle");
  if (input.textAlign !== undefined) enumValue(input.textAlign, ["left", "center", "right"], "textAlign");
  if (input.verticalAlign !== undefined) enumValue(input.verticalAlign, ["top", "middle", "bottom"], "verticalAlign");
  if (input.locked !== undefined && typeof input.locked !== "boolean") throw new Error("locked must be a boolean");
}

function enumValue<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) throw new Error(`invalid ${field}`);
  return value;
}

function addElement(scene: SceneDocument, input: SemanticElementInput): string {
  const element = normalizeSemanticElement(input);
  if (scene.elements.some((candidate) => candidate.id === element.id)) {
    throw new Error(`element '${String(element.id)}' already exists`);
  }
  scene.elements.push(element);
  return String(element.id);
}

function assertUniqueIds(elements: JsonObject[]): void {
  const ids = elements.map((element) => String(element.id));
  if (new Set(ids).size !== ids.length) throw new Error("element ids must be unique");
}

function assertUniqueSelection(ids: string[], minimum: number): void {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > 100) {
    throw new Error(`operation requires between ${minimum} and 100 element ids`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("operation element ids must be unique");
}

function parseOperation(value: unknown): CanvasOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("operation must be an object");
  const operation = value as Record<string, unknown>;
  const keysByKind: Record<string, string[]> = {
    add: ["kind", "element"], update: ["kind", "id", "patch"], delete: ["kind", "id"], restore: ["kind", "id"],
    group: ["kind", "ids"], ungroup: ["kind", "group_id"], "set-frame": ["kind", "ids", "frame_id"],
    reorder: ["kind", "ids", "anchor_id", "position"],
  };
  if (typeof operation.kind !== "string" || !Object.hasOwn(keysByKind, operation.kind)) throw new Error(`unsupported operation '${String(operation.kind)}'`);
  const keys = keysByKind[operation.kind];
  if (Object.keys(operation).length !== keys.length || keys.some((key) => !Object.hasOwn(operation, key))) throw new Error("unsupported or missing operation fields");
  switch (operation.kind) {
    case "add":
      normalizeSemanticElement(operation.element as SemanticElementInput);
      return { kind: "add", element: operation.element as SemanticElementInput };
    case "update":
      if (!operation.patch || typeof operation.patch !== "object" || Array.isArray(operation.patch)) throw new Error("update patch must be an object");
      for (const key of Object.keys(operation.patch)) if (!allowedPatchKeys.has(key)) throw new Error(`unsupported patch field '${key}'`);
      validatePatchValues(operation.patch as SemanticUpdatePatch);
      return { kind: "update", id: elementId(operation.id), patch: operation.patch as SemanticUpdatePatch };
    case "delete":
    case "restore":
      return { kind: operation.kind, id: elementId(operation.id) };
    case "group":
      return { kind: "group", ids: parseIds(operation.ids, 2) };
    case "ungroup":
      return { kind: "ungroup", group_id: elementId(operation.group_id) };
    case "set-frame": {
      const frameId = operation.frame_id === null ? null : elementId(operation.frame_id);
      return { kind: "set-frame", ids: parseIds(operation.ids), frame_id: frameId };
    }
    case "reorder": {
      if (operation.position !== "before" && operation.position !== "after") throw new Error("invalid reorder position");
      return {
        kind: "reorder",
        ids: parseIds(operation.ids),
        anchor_id: elementId(operation.anchor_id),
        position: operation.position,
      };
    }
    default:
      throw new Error(`unsupported operation '${String(operation.kind)}'`);
  }
}

function parseIds(value: unknown, minimum = 1): string[] {
  if (!Array.isArray(value)) throw new Error("operation ids must be an array");
  const ids = value.map(elementId);
  assertUniqueSelection(ids, minimum);
  return ids;
}
