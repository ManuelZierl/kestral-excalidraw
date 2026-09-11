import type { BoardDocument } from "./boardDocument";
import { parseBoardDocument } from "./boardDocument";
import {
  CANVAS_DOCUMENTS, DataV2Adapter, DataV2ConflictError, MAX_TITLE_BYTES,
  type DocumentMutation, type ManagedDocumentRecord, encodeDocument, decodeDocument,
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
  constructor(private readonly data: DataV2Adapter) {}

  async listCanvases(): Promise<CanvasMeta[]> {
    const result = await this.data.listDocuments<CanvasMetadata>(CANVAS_DOCUMENTS);
    return result.documents.map(toCanvasMeta);
  }

  async loadCanvas(id: string): Promise<CanvasRecord | null> {
    const found = await this.data.getDocument<CanvasMetadata>(CANVAS_DOCUMENTS, id);
    if (!found.document) return null;
    const bytes = await this.data.readDocument(CANVAS_DOCUMENTS, found.document, found.generation);
    return { ...toCanvasMeta(found.document), scene: parseBoardDocument(decodeDocument(bytes)) };
  }

  async getCanvasMeta(id: string): Promise<CanvasMeta | null> {
    const found = await this.data.getDocument<CanvasMetadata>(CANVAS_DOCUMENTS, id);
    return found.document ? toCanvasMeta(found.document) : null;
  }

  async createCanvas(title: string, scene: BoardDocument = EMPTY_DOCUMENT): Promise<CreateCanvasResult> {
    assertTitle(title);
    scene = parseBoardDocument(scene);
    const encoded = await encodeDocument(scene);
    const committed = await this.data.runBatch<CanvasMetadata>({
      expectedGeneration: await this.requireGeneration(),
      documents: [{ kind: "create", stageId: "scene", collection: CANVAS_DOCUMENTS, metadata: metadataFor(title, scene), contentLength: encoded.bytes.byteLength, contentSha256: encoded.contentSha256 }],
      contents: [{ stageId: "scene", bytes: encoded.bytes }],
    });
    const document = committed.documents[0];
    if (!document) throw new Error("The host committed a canvas without returning its document.");
    return { canvas: toCanvasMeta(document) };
  }

  async replaceCanvas(canvas: CanvasMeta, scene: BoardDocument, receipt?: AppliedProposalReceipt, expectedGeneration?: number): Promise<MutationResult> {
    scene = parseBoardDocument(scene);
    const encoded = await encodeDocument(scene);
    return this.runMutation(canvas, {
      expectedGeneration,
      documents: [{ kind: "replace", stageId: "scene", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision, metadata: metadataFor(canvas.title, scene, receipt ? appendReceipt(canvas.metadata, receipt) : canvas.metadata), contentLength: encoded.bytes.byteLength, contentSha256: encoded.contentSha256 }],
      contents: [{ stageId: "scene", bytes: encoded.bytes }],
    });
  }

  async manageCanvas(canvas: CanvasMeta, action: "rename" | "duplicate" | "trash" | "restore", title?: string): Promise<MutationResult | CreateCanvasResult> {
    if (action === "duplicate") {
      const source = await this.loadCanvas(canvas.id);
      if (!source) return { outcome: "not-found", canvas: null };
      return this.createCanvas(title ?? deriveCopyTitle(source.title), source.scene);
    }
    if (action === "rename") assertTitle(title ?? "");
    if (action === "trash" && canvas.trashed_at !== null || action === "restore" && canvas.trashed_at === null) return { outcome: "not-trashed", canvas };
    const metadata = { ...canvas.metadata, title: title ?? canvas.title, trashed_at: action === "trash" ? new Date().toISOString() : action === "restore" ? null : canvas.trashed_at };
    return this.runMutation(canvas, { documents: [{ kind: "update-metadata", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision, metadata }], contents: [] });
  }

  async purgeCanvas(canvas: CanvasMeta): Promise<PurgeResult> {
    if (canvas.trashed_at === null) return { outcome: "not-trashed", id: canvas.id, canvas };
    try {
      await this.data.runBatch<CanvasMetadata>({ expectedGeneration: await this.requireGeneration(), documents: [{ kind: "delete", collection: CANVAS_DOCUMENTS, id: canvas.id, expectedRevision: canvas.revision }], contents: [] });
      return { outcome: "purged", id: canvas.id, canvas: null };
    } catch (error) {
      if (!isConflict(error)) throw error;
      const latest = await this.getCanvasMeta(canvas.id);
      return { outcome: latest ? "conflict" : "not-found", id: canvas.id, canvas: latest };
    }
  }

  async applyProposal(canvas: CanvasMeta, proposal: CanvasProposal): Promise<MutationResult & { changes?: unknown }> {
    const target = await this.proposalTarget(canvas, proposal);
    if ("outcome" in target) return target;
    try {
      const bytes = await this.data.readDocument(CANVAS_DOCUMENTS, target.document, target.generation);
      const scene = parseBoardDocument(decodeDocument(bytes));
      const applied = applyCanvasOperations(scene as unknown as SceneDocument, proposal.operations);
      const result = await this.replaceCanvas(target.canvas, applied.scene as unknown as BoardDocument,
        { proposal_id: proposal.artifactId, status: "applied", target_revision: target.canvas.revision }, target.generation);
      return { ...result, changes: applied.changes };
    } catch (error) {
      return this.mutationFailure(canvas.id, error);
    }
  }

  async rejectProposal(canvas: CanvasMeta, proposal: CanvasProposal): Promise<MutationResult> {
    const target = await this.proposalTarget(canvas, proposal);
    if ("outcome" in target) return target;
    return this.runMutation(target.canvas, {
      expectedGeneration: target.generation,
      documents: [{ kind: "update-metadata", collection: CANVAS_DOCUMENTS, id: target.canvas.id, expectedRevision: target.canvas.revision,
        metadata: appendReceipt(target.canvas.metadata, { proposal_id: proposal.artifactId, status: "rejected", target_revision: target.canvas.revision }) }],
      contents: [],
    });
  }

  private async proposalTarget(canvas: CanvasMeta, proposal: CanvasProposal): Promise<MutationResult | {
    canvas: CanvasMeta; document: ManagedDocumentRecord<CanvasMetadata>; generation: number;
  }> {
    if (canvas.id !== proposal.targetId) throw new Error("The proposal targets a different canvas.");
    const found = await this.data.getDocument<CanvasMetadata>(CANVAS_DOCUMENTS, proposal.targetId);
    if (!found.document) return { outcome: "not-found", canvas: null };
    const latest = toCanvasMeta(found.document);
    if (latest.metadata.applied_proposals.some((receipt) => receipt.proposal_id === proposal.artifactId)) return { outcome: "replayed", canvas: latest };
    if (latest.trashed_at !== null || latest.revision !== proposal.targetRevision || found.generation !== proposal.targetGeneration) return { outcome: "stale", canvas: latest };
    return { canvas: latest, document: found.document, generation: found.generation };
  }

  private async runMutation(canvas: CanvasMeta, input: { expectedGeneration?: number; documents: DocumentMutation[]; contents: Array<{ stageId: string; bytes: Uint8Array }> }): Promise<MutationResult> {
    try {
      const committed = await this.data.runBatch<CanvasMetadata>({ ...input, expectedGeneration: input.expectedGeneration ?? await this.requireGeneration() });
      const document = committed.documents.find((item) => item.id === canvas.id);
      if (!document) throw new Error("The host committed a canvas mutation without returning its document.");
      return { outcome: "applied", canvas: toCanvasMeta(document) };
    } catch (error) {
      return this.mutationFailure(canvas.id, error);
    }
  }

  private async mutationFailure(id: string, error: unknown): Promise<MutationResult> {
    if (!isConflict(error)) throw error;
    const latest = await this.getCanvasMeta(id);
    return { outcome: latest ? "conflict" : "not-found", canvas: latest };
  }

  private async requireGeneration(): Promise<number> {
    // A generation belongs to one snapshot/batch, not the repository lifetime.
    const snapshot = await this.data.readSnapshot({ reads: [{ kind: "document-list", collection: CANVAS_DOCUMENTS, limit: 1 }] });
    return snapshot.generation;
  }
}

export function deriveCopyTitle(title: string, conflict = false): string {
  const prefix = conflict ? "" : "Copy of ";
  const suffix = conflict ? " (conflict copy)" : "";
  const encoder = new TextEncoder();
  let remaining = MAX_TITLE_BYTES - encoder.encode(prefix + suffix).byteLength;
  let truncated = "";
  for (const character of title) {
    const length = encoder.encode(character).byteLength;
    if (length > remaining) break;
    truncated += character;
    remaining -= length;
  }
  return `${prefix}${truncated.trimEnd()}${suffix}`;
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
  const summary = summarizeScene(scene);
  return { schema_version: 2, title, trashed_at: existing?.trashed_at ?? null, summary, searchable_text: summary.text_snippets.join(" ").slice(0, 4096), applied_proposals: existing?.applied_proposals ?? [] };
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
