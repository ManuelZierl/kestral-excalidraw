import type { BoardDocument } from "./boardDocument";
import { parseBoardDocument } from "./boardDocument";
import {
  CANVAS_DOCUMENTS, DataV2Adapter, DataV2ConflictError, MAX_TITLE_BYTES,
  type BatchResult, type DocumentMutation, type ManagedDocumentRecord, encodeDocument, decodeDocument,
} from "./dataV2Adapter";
import { applyCanvasOperations } from "./semanticOperations";
import type { JsonObject, SceneDocument } from "./semanticTypes";
import type { CanvasProposal } from "./proposals";

export interface CanvasSummary {
  element_count: number;
  element_count_by_type: Record<string, number>;
  deleted_count: number;
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number } | null;
  text_snippets: string[];
}

export interface AppliedProposalReceipt { proposal_id: string; status: "applied" | "rejected"; target_revision: number; }
export interface CanvasMetadata {
  schema_version: 2;
  title: string;
  trashed_at: string | null;
  summary: CanvasSummary;
  searchable_text: string;
  applied_proposals: AppliedProposalReceipt[];
}

export interface CanvasMeta {
  format_version: 2;
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  revision: number;
  trashed_at: string | null;
  byte_length: number;
  sha256: string;
  summary: CanvasSummary;
  metadata: CanvasMetadata;
}
export interface CanvasRecord extends CanvasMeta { scene: BoardDocument; }
export interface MutationResult { outcome: "applied" | "conflict" | "not-found" | "not-trashed" | "replayed" | "stale"; canvas: CanvasMeta | null; }
export interface CreateCanvasResult { canvas: CanvasMeta; }
export interface PurgeResult { outcome: "purged" | "conflict" | "not-found" | "not-trashed"; id: string; canvas: CanvasMeta | null; }

const EMPTY_DOCUMENT: BoardDocument = { type: "kestral-excalidraw", version: 1, editor: "excalidraw", elements: [], appState: {}, files: {} };

export class CanvasRepository {
  private generation: number | null = null;
  constructor(private readonly data: DataV2Adapter) {}

  async listCanvases(): Promise<CanvasMeta[]> {
    const result = await this.data.listDocuments<CanvasMetadata>(CANVAS_DOCUMENTS, this.generation ?? undefined);
    this.generation = result.generation;
    return result.documents.map(toCanvasMeta);
  }

  async loadCanvas(id: string): Promise<CanvasRecord | null> {
    const found = await this.data.getDocument<CanvasMetadata>(CANVAS_DOCUMENTS, id, this.generation ?? undefined);
    this.generation = found.generation;
    if (!found.document) return null;
    const bytes = await this.data.readDocument(CANVAS_DOCUMENTS, found.document, found.generation);
    return { ...toCanvasMeta(found.document), scene: parseBoardDocument(decodeDocument(bytes)) };
  }

  async getCanvasMeta(id: string): Promise<CanvasMeta | null> {
    const found = await this.data.getDocument<CanvasMetadata>(CANVAS_DOCUMENTS, id, this.generation ?? undefined);
    this.generation = found.generation;
    return found.document ? toCanvasMeta(found.document) : null;
  }

  async createCanvas(title: string, scene: BoardDocument = EMPTY_DOCUMENT): Promise<CreateCanvasResult> {
    assertTitle(title);
    const encoded = await encodeDocument(scene);
    const committed = await this.data.runBatch<CanvasMetadata>({
      expectedGeneration: await this.requireGeneration(),
      documents: [{ kind: "create", stageId: "scene", collection: CANVAS_DOCUMENTS, metadata: metadataFor(title, scene), contentLength: encoded.bytes.byteLength, contentSha256: encoded.contentSha256 }],
      contents: [{ stageId: "scene", bytes: encoded.bytes }],
    });
    this.generation = committed.generation;
    const document = committed.documents[0];
    if (!document) throw new Error("The host committed a canvas without returning its document.");
    return { canvas: toCanvasMeta(document) };
  }

  async replaceCanvas(canvas: CanvasMeta, scene: BoardDocument, receipt?: AppliedProposalReceipt): Promise<MutationResult> {
    const encoded = await encodeDocument(scene);
    return this.runMutation(canvas, {
      documents: [{ kind: "replace", stageId: "scene", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision, metadata: metadataFor(canvas.title, scene, receipt ? appendReceipt(canvas.metadata, receipt) : canvas.metadata), contentLength: encoded.bytes.byteLength, contentSha256: encoded.contentSha256 }],
      contents: [{ stageId: "scene", bytes: encoded.bytes }],
    });
  }

  async manageCanvas(canvas: CanvasMeta, action: "rename" | "duplicate" | "trash" | "restore", title?: string): Promise<MutationResult | CreateCanvasResult> {
    if (action === "duplicate") {
      const source = await this.loadCanvas(canvas.id);
      if (!source) return { outcome: "not-found", canvas: null };
      return this.createCanvas(title ?? `Copy of ${canvas.title}`, source.scene);
    }
    if (action === "rename") assertTitle(title ?? "");
    if (action === "trash" && canvas.trashed_at !== null || action === "restore" && canvas.trashed_at === null) return { outcome: "not-trashed", canvas };
    const metadata = { ...canvas.metadata, title: title ?? canvas.title, trashed_at: action === "trash" ? new Date().toISOString() : action === "restore" ? null : canvas.trashed_at };
    return this.runMutation(canvas, { documents: [{ kind: "update-metadata", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision, metadata }], contents: [] });
  }

  async purgeCanvas(canvas: CanvasMeta): Promise<PurgeResult> {
    if (canvas.trashed_at === null) return { outcome: "not-trashed", id: canvas.id, canvas };
    try {
      const committed = await this.data.runBatch<CanvasMetadata>({ expectedGeneration: await this.requireGeneration(), documents: [{ kind: "delete", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision }], contents: [] });
      this.generation = committed.generation;
      return { outcome: "purged", id: canvas.id, canvas: null };
    } catch (error) {
      if (!isConflict(error)) throw error;
      this.generation = (await this.data.listDocuments(CANVAS_DOCUMENTS)).generation;
      return { outcome: "conflict", id: canvas.id, canvas: await this.getCanvasMeta(canvas.id) };
    }
  }

  async applyProposal(canvas: CanvasMeta, proposal: CanvasProposal): Promise<MutationResult & { changes?: unknown }> {
    if (canvas.metadata.applied_proposals.some((receipt) => receipt.proposal_id === proposal.artifactId)) return { outcome: "replayed", canvas };
    if (canvas.revision !== proposal.targetRevision || this.generation !== proposal.targetGeneration) return { outcome: "stale", canvas };
    const loaded = await this.loadCanvas(canvas.id);
    if (!loaded) return { outcome: "not-found", canvas: null };
    const applied = applyCanvasOperations(loaded.scene as unknown as SceneDocument, proposal.operations);
    const result = await this.replaceCanvas(canvas, applied.scene as unknown as BoardDocument, { proposal_id: proposal.artifactId, status: "applied", target_revision: canvas.revision });
    return { ...result, changes: applied.changes };
  }

  async rejectProposal(canvas: CanvasMeta, proposal: CanvasProposal): Promise<MutationResult> {
    if (canvas.metadata.applied_proposals.some((receipt) => receipt.proposal_id === proposal.artifactId)) return { outcome: "replayed", canvas };
    if (canvas.revision !== proposal.targetRevision || this.generation !== proposal.targetGeneration) return { outcome: "stale", canvas };
    return this.runMutation(canvas, { documents: [{ kind: "update-metadata", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision, metadata: appendReceipt(canvas.metadata, { proposal_id: proposal.artifactId, status: "rejected", target_revision: canvas.revision }) }], contents: [] });
  }

  private async runMutation(canvas: CanvasMeta, input: { documents: DocumentMutation[]; contents: Array<{ stageId: string; bytes: Uint8Array }> }): Promise<MutationResult> {
    try {
      const committed = await this.data.runBatch<CanvasMetadata>({ expectedGeneration: await this.requireGeneration(), ...input });
      this.generation = committed.generation;
      const document = committed.documents.find((item) => item.id === canvas.id);
      if (!document) throw new Error("The host committed a canvas mutation without returning its document.");
      return { outcome: "applied", canvas: toCanvasMeta(document) };
    } catch (error) {
      if (!isConflict(error)) throw error;
      this.generation = (await this.data.listDocuments(CANVAS_DOCUMENTS)).generation;
      return { outcome: "conflict", canvas: await this.getCanvasMeta(canvas.id) };
    }
  }

  private async requireGeneration(): Promise<number> {
    if (this.generation !== null) return this.generation;
    this.generation = (await this.data.listDocuments(CANVAS_DOCUMENTS)).generation;
    return this.generation;
  }
}

export function summarizeScene(scene: BoardDocument): CanvasSummary {
  const live = scene.elements.filter((element) => !element.isDeleted);
  const counts: Record<string, number> = {};
  let bounds: CanvasSummary["bounds"] = null;
  const snippets: string[] = [];
  for (const element of live) {
    counts[element.type] = (counts[element.type] ?? 0) + 1;
    const raw = element as unknown as Record<string, unknown>;
    const x = Number(raw.x ?? 0), y = Number(raw.y ?? 0), maxX = x + Number(raw.width ?? 0), maxY = y + Number(raw.height ?? 0);
    bounds = bounds ? { min_x: Math.min(bounds.min_x, x), min_y: Math.min(bounds.min_y, y), max_x: Math.max(bounds.max_x, maxX), max_y: Math.max(bounds.max_y, maxY) } : { min_x: x, min_y: y, max_x: maxX, max_y: maxY };
    const text = typeof raw.text === "string" ? raw.text : typeof raw.name === "string" ? raw.name : "";
    if (text && snippets.length < 5) snippets.push(text.slice(0, 120));
  }
  return { element_count: live.length, element_count_by_type: counts, deleted_count: scene.elements.length - live.length, bounds, text_snippets: snippets };
}

export function projectElements(scene: BoardDocument, query: { type?: string; text?: string; limit?: number; after?: string } = {}): { elements: JsonObject[]; next_after: string | null; truncated: boolean } {
  const matches = scene.elements.filter((element) => { const raw = element as unknown as Record<string, unknown>; return (!query.type || element.type === query.type) && (!query.text || String(raw.text ?? raw.name ?? "").toLocaleLowerCase().includes(query.text.toLocaleLowerCase())); });
  const start = query.after ? Math.max(0, matches.findIndex((element) => element.id === query.after) + 1) : 0;
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const selected = matches.slice(start, start + limit).map((element) => { const projection = structuredClone(element) as JsonObject; delete projection.dataURL; return projection; });
  return { elements: selected, next_after: start + limit < matches.length ? String(matches[start + limit - 1].id) : null, truncated: start + limit < matches.length };
}

export function searchCanvasMetadata(canvases: CanvasMeta[], query: string): CanvasMeta[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? canvases.filter((canvas) => [canvas.title, ...canvas.summary.text_snippets].some((value) => value.toLocaleLowerCase().includes(needle))) : canvases;
}

function metadataFor(title: string, scene: BoardDocument, existing?: CanvasMetadata): CanvasMetadata {
  return { schema_version: 2, title, trashed_at: existing?.trashed_at ?? null, summary: summarizeScene(scene), searchable_text: summarizeScene(scene).text_snippets.join(" ").slice(0, 4096), applied_proposals: existing?.applied_proposals ?? [] };
}
function appendReceipt(metadata: CanvasMetadata, receipt: AppliedProposalReceipt): CanvasMetadata {
  if (metadata.applied_proposals.some((item) => item.proposal_id === receipt.proposal_id)) return metadata;
  if (metadata.applied_proposals.length >= 32) throw new Error("Canvas proposal receipt capacity is full.");
  return { ...metadata, applied_proposals: [...metadata.applied_proposals, receipt] };
}
function toCanvasMeta(document: ManagedDocumentRecord<CanvasMetadata>): CanvasMeta {
  const metadata = validateMetadata(document.metadata);
  return { format_version: 2, id: document.id, title: metadata.title, created_at: document.createdAt, updated_at: document.updatedAt, revision: document.revision, trashed_at: metadata.trashed_at, byte_length: document.contentLength, sha256: document.contentSha256, summary: metadata.summary, metadata };
}
function validateMetadata(value: object): CanvasMetadata {
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "applied_proposals,schema_version,searchable_text,summary,title,trashed_at" || candidate.schema_version !== 2 || typeof candidate.title !== "string" || candidate.title.trim() !== candidate.title || !candidate.title || typeof candidate.searchable_text !== "string" || candidate.searchable_text.length > 4096 || !isSummary(candidate.summary) || !Array.isArray(candidate.applied_proposals) || candidate.applied_proposals.length > 32) throw new Error("The host returned invalid canvas metadata.");
  return candidate as unknown as CanvasMetadata;
}
function isSummary(value: unknown): value is CanvasSummary { return isObject(value) && Number.isSafeInteger(value.element_count) && Number.isSafeInteger(value.deleted_count) && isObject(value.element_count_by_type) && Array.isArray(value.text_snippets) && (value.bounds === null || isObject(value.bounds)); }
function assertTitle(title: string) { if (!title || title.trim() !== title || new TextEncoder().encode(title).byteLength > MAX_TITLE_BYTES) throw new Error(`Canvas names must be non-empty and at most ${MAX_TITLE_BYTES} bytes.`); }
function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isConflict(error: unknown) { return error instanceof DataV2ConflictError || /conflict|stale|compare-and-swap|generation|revision/i.test(error instanceof Error ? error.message : String(error)); }
