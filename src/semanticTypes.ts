export type JsonObject = Record<string, unknown>;

export interface SceneDocument {
  type: "kestral-excalidraw";
  version: 1;
  editor: "excalidraw";
  elements: JsonObject[];
  appState: JsonObject;
  files: JsonObject;
}

export interface OperationChanges {
  created_element_ids: string[];
  created_group_ids: string[];
  updated_element_ids: string[];
  deleted_element_ids: string[];
  restored_element_ids: string[];
}

export type SemanticKind = "text" | "rectangle" | "ellipse" | "diamond" | "line" | "arrow" | "frame";

export type CanvasOperation =
  | { kind: "add"; element: SemanticElementInput }
  | { kind: "update"; id: string; patch: SemanticUpdatePatch }
  | { kind: "delete"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "group"; ids: string[] }
  | { kind: "ungroup"; group_id: string }
  | { kind: "set-frame"; ids: string[]; frame_id: string | null }
  | { kind: "reorder"; ids: string[]; anchor_id: string; position: "before" | "after" };

export interface SemanticElementInput {
  type: SemanticKind;
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  locked?: boolean;
}

export interface SemanticUpdatePatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  locked?: boolean;
}
