import { vi } from "vitest";
import { encodeDocument } from "../dataV2Adapter";
import type { AppHostBridge } from "../hostBridge";

export class FakeDataV2 {
  generation = 1;
  nextId = 1;
  conflictOnReplace = false;
  proposalEnabled = false;
  proposalStale = false;
  documents = new Map<string, any>();
  batches: any[] = [];
  commits: any[] = [];
  state = new Map<string, { revision: number; value: Record<string, unknown> | null }>();
  host: AppHostBridge;
  reads: any[] = [];
  beforeRead: ((request: any) => Promise<void>) | null = null;
  afterRead: ((request: any) => Promise<void>) | null = null;
  beforeCommit: (() => Promise<void>) | null = null;
  afterCommit: (() => Promise<void>) | null = null;
  artifacts: any[] | null = null;
  private cachedProposal: any = null;
  private init: ((context: { theme: "light" | "dark" | null; variables: Record<string, string> }) => void) | null = null;

  constructor() {
    const wire = {
      readSnapshot: async (request: any) => this.readSnapshot(request),
      beginBatch: async (request: any) => {
        while (this.documents.has(uuid(this.nextId))) this.nextId += 1;
        if (request.expectedGeneration !== this.generation) throw new Error("generation conflict");
        const batch = { id: `batch-${this.batches.length + 1}`, ...request, staged: new Map<string, string>(), chunks: new Map<string, Uint8Array[]>() };
        for (const document of request.documents) if (document.stageId) batch.staged.set(document.stageId, document.kind === "create" ? uuid(this.nextId++) : document.id);
        this.batches.push(batch);
        return { batchId: batch.id, generation: this.generation, documents: [...batch.staged].map(([stageId, documentId]) => ({ stageId, documentId })) };
      },
      appendDocumentChunk: async (request: any) => {
        const batch = this.batches.find((candidate) => candidate.id === request.batchId);
        const chunks = batch.chunks.get(request.documentId) ?? [];
        chunks[request.chunkIndex] = fromBase64(request.contentBase64);
        batch.chunks.set(request.documentId, chunks);
      },
      commitBatch: async (request: any) => this.commitBatch(request.batchId),
      abortBatch: async () => {},
    };
    this.host = {
      theme: "light", variables: {}, ready: () => this.init?.({ theme: "light", variables: {} }), reportError: vi.fn(), onInit: (callback: (context: { theme: "light" | "dark" | null; variables: Record<string, string> }) => void) => { this.init = callback; }, onEvent: () => {},
      invoke: async () => ({}), invokeScoped: async () => ({}), listArtifacts: async () => this.artifacts ?? (this.proposalEnabled && this.documents.size ? [this.cachedProposal ??= this.proposal()] : []), data: { v2: wire },
      getState: async (key: string) => structuredClone(this.state.get(key) ?? { revision: 0, value: null }),
      putState: async (key: string, expectedRevision: number, value: Record<string, unknown> | null) => {
        const current = this.state.get(key) ?? { revision: 0, value: null };
        if (current.revision !== expectedRevision) throw new Error("surface state revision conflict");
        const updated = { revision: current.revision + 1, value: structuredClone(value) };
        this.state.set(key, updated);
        return structuredClone(updated);
      },
    } as unknown as AppHostBridge;
  }

  seedState(key: string, value: Record<string, unknown> | null) {
    this.state.set(key, { revision: 1, value: structuredClone(value) });
  }

  async seedCanvas(id: string, title: string, sceneId: string) {
    const scene = { type: "kestral-excalidraw", version: 1, editor: "excalidraw", elements: [testElement(sceneId)], appState: {}, files: {} };
    const encoded = await encodeDocument(scene);
    this.documents.set(id, {
      id,
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
      metadata: {
        schema_version: 2,
        title,
        trashed_at: null,
        summary: { element_count: 1, element_count_by_type: {}, deleted_count: 0, bounds: null, text_snippets: [] },
        searchable_text: "",
        applied_proposals: [],
      },
      contentSha256: encoded.contentSha256,
      contentLength: encoded.bytes.length,
      bytes: encoded.bytes,
    });
  }

  private proposal() {
    const document = [...this.documents.values()][0];
    return { artifact_id: "proposal-1", artifact_type: "canvas-operations-proposal", title: "Add proposal text", content: { targetAppId: "com.ma-zierl.kestral-excalidraw", targetKind: "document", collection: "canvases", resourceId: `app-data:com.ma-zierl.kestral-excalidraw:canvases:document:${document.id}`, targetGeneration: this.generation, targetRevision: this.proposalStale ? document.revision + 1 : document.revision, payload: { operations: [{ kind: "add", element: { type: "text", id: "proposal-text", text: "Approved" } }] } } };
  }

  private async readSnapshot(request: any) {
    this.reads.push(structuredClone(request));
    await this.beforeRead?.(request);
    if (request.expectedGeneration !== undefined && request.expectedGeneration !== this.generation) throw new Error("generation conflict");
    const result = this.snapshot(request);
    await this.afterRead?.(request);
    return result;
  }

  private snapshot(request: any) {
    const read = request.reads[0];
    if (read.kind === "document-list") return { generation: this.generation, results: [{ kind: "document-list", documents: [...this.documents.values()].map(publicDocument), nextAfter: null }] };
    const document = this.documents.get(read.id) ?? null;
    if (read.kind === "document-get") return { generation: this.generation, results: [{ kind: "document-get", document: document ? publicDocument(document) : null }] };
    const content = document.bytes.slice(read.offset, read.offset + read.length);
    return { generation: this.generation, results: [{ kind: "document-content", document: publicDocument(document), offset: read.offset, contentBase64: toBase64(content), contentLength: document.contentLength }] };
  }

  private async commitBatch(batchId: string) {
    await this.beforeCommit?.();
    const batch = this.batches.find((candidate) => candidate.id === batchId);
    if (batch.expectedGeneration !== this.generation) throw new Error("generation conflict");
    const touched: any[] = [];
    for (const stage of batch.documents) {
      const id = batch.staged.get(stage.stageId) ?? stage.id;
      const current = this.documents.get(id);
      if (stage.kind === "delete") {
        if (!current || current.revision !== stage.expectedRevision) throw new Error("revision conflict");
        this.documents.delete(id); continue;
      }
      if ((stage.kind === "replace" || stage.kind === "update-metadata") && (!current || current.revision !== stage.expectedRevision)) throw new Error("revision conflict");
      if (this.conflictOnReplace && stage.kind === "replace") { this.conflictOnReplace = false; throw new Error("revision conflict"); }
      const bytes = stage.kind === "update-metadata" ? current.bytes : concat(batch.chunks.get(id) ?? []);
      const document = { id, revision: current ? current.revision + 1 : 1, createdAt: current?.createdAt ?? now(), updatedAt: now(), metadata: stage.metadata, contentSha256: stage.kind === "update-metadata" ? current.contentSha256 : stage.contentSha256, contentLength: bytes.length, bytes };
      this.documents.set(id, document); touched.push(publicDocument(document));
    }
    this.generation += 1;
    const result = { generation: this.generation, records: [], documents: touched };
    this.commits.push(result);
    await this.afterCommit?.();
    return result;
  }
}

function publicDocument(document: any) { const { bytes: _bytes, ...metadata } = document; return structuredClone(metadata); }
function concat(chunks: Uint8Array[]) { const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0)); let offset = 0; for (const chunk of chunks) { if (!chunk) continue; result.set(chunk, offset); offset += chunk.length; } return result; }
export function uuid(seed: number) { return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`; }
function now() { return "2026-08-05T00:00:00.000Z"; }
function toBase64(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }

export function testElement(id: string) { return { id, type: "rectangle", x: 0, y: 0, width: 100, height: 60, isDeleted: false }; }

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
