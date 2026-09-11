import type { AppHostBridge } from "./hostBridge";

export const CANVAS_DOCUMENTS = "canvases";
export const MAX_SCENE_BYTES = 7 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 384 * 1024;
export const MAX_TITLE_BYTES = 120;

export interface ManagedDocumentRecord<T extends object = Record<string, unknown>> {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  metadata: T;
  contentSha256: string;
  contentLength: number;
}

export type DataV2Read =
  | { kind: "document-get"; collection: string; id: string }
  | { kind: "document-list"; collection: string; after?: string; limit?: number }
  | { kind: "document-content"; collection: string; id: string; offset: number; length: number };

export type DataV2ReadResult =
  | { kind: "document-get"; document: ManagedDocumentRecord | null }
  | { kind: "document-list"; documents: ManagedDocumentRecord[]; nextAfter: string | null }
  | { kind: "document-content"; document: ManagedDocumentRecord; offset: number; contentBase64: string; contentLength: number };

interface ReadSnapshotResult {
  generation: number;
  results: DataV2ReadResult[];
}

export type DocumentMutation =
  | {
      kind: "create";
      stageId: string;
      collection: string;
      metadata: object;
      contentLength: number;
      contentSha256: string;
    }
  | {
      kind: "replace";
      stageId: string;
      collection: string;
      id: string;
      expectedRevision: number;
      metadata: object;
      contentLength: number;
      contentSha256: string;
    }
  | {
      kind: "update-metadata";
      collection: string;
      id: string;
      expectedRevision: number;
      metadata: object;
    }
  | {
      kind: "delete";
      collection: string;
      id: string;
      expectedRevision: number;
    };

interface BeginBatchResult {
  batchId: string;
  generation: number;
  documents: Array<{ stageId: string; documentId: string }>;
}

export interface BatchResult<T extends object> {
  generation: number;
  records: unknown[];
  documents: Array<ManagedDocumentRecord<T>>;
}

interface DataV2Wire {
  readSnapshot(request: { expectedGeneration?: number; reads: DataV2Read[] }): Promise<ReadSnapshotResult>;
  beginBatch(request: { mutationId: string; expectedGeneration: number; operations: []; documents: DocumentMutation[] }): Promise<BeginBatchResult>;
  appendDocumentChunk(request: { mutationId: string; batchId: string; documentId: string; chunkIndex: number; contentBase64: string }): Promise<unknown>;
  commitBatch(request: { mutationId: string; batchId: string }): Promise<BatchResult<Record<string, unknown>>>;
  abortBatch(request: { mutationId: string; batchId: string }): Promise<unknown>;
}

interface HostWithDataV2 extends AppHostBridge {
  data: { v2: DataV2Wire };
}

export class DataV2UnavailableError extends Error {
  constructor() {
    super("Kestral data.v2 is unavailable in this surface.");
  }
}

export class DataV2ConflictError extends Error {
  constructor(message = "The canvas changed elsewhere.") {
    super(message);
  }
}

export function createDataV2Adapter(host: AppHostBridge | undefined): DataV2Adapter | null {
  if (!host) return null;
  const candidate = host as Partial<HostWithDataV2>;
  if (!candidate.data?.v2) throw new DataV2UnavailableError();
  return new DataV2Adapter(candidate.data.v2);
}

export class DataV2Adapter {
  constructor(private readonly wire: DataV2Wire) {}

  async readSnapshot(request: { expectedGeneration?: number; reads: DataV2Read[] }): Promise<ReadSnapshotResult> {
    const result = await this.wire.readSnapshot(request);
    if (!Number.isSafeInteger(result.generation) || result.generation < 0 || !Array.isArray(result.results) || result.results.length !== request.reads.length) {
      throw new Error("The host returned an invalid data.v2 snapshot.");
    }
    if (request.expectedGeneration !== undefined && result.generation !== request.expectedGeneration) {
      throw new DataV2ConflictError("The host returned a different snapshot generation.");
    }
    return result;
  }

  async listDocuments<T extends object = Record<string, unknown>>(collection: string, expectedGeneration?: number): Promise<{ generation: number; documents: Array<ManagedDocumentRecord<T>> }> {
    const documents: Array<ManagedDocumentRecord<T>> = [];
    let after: string | undefined;
    let generation: number | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.readSnapshot({
        ...((generation ?? expectedGeneration) === undefined ? {} : { expectedGeneration: generation ?? expectedGeneration }),
        reads: [{ kind: "document-list", collection, ...(after ? { after } : {}), limit: 100 }],
      });
      generation ??= result.generation;
      if (result.generation !== generation) throw new DataV2ConflictError("Canvas listing changed during a coherent snapshot.");
      const pageResult = result.results[0];
      if (pageResult.kind !== "document-list") throw new Error("The host returned the wrong data.v2 list result.");
      documents.push(...pageResult.documents as Array<ManagedDocumentRecord<T>>);
      after = pageResult.nextAfter ?? undefined;
      if (!after) return { generation, documents };
    }
    throw new Error("The canvas collection exceeds the supported listing bound.");
  }

  async getDocument<T extends object = Record<string, unknown>>(collection: string, id: string, expectedGeneration?: number): Promise<{ generation: number; document: ManagedDocumentRecord<T> | null }> {
    const result = await this.readSnapshot({
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      reads: [{ kind: "document-get", collection, id }],
    });
    const item = result.results[0];
    if (item.kind !== "document-get") throw new Error("The host returned the wrong data.v2 document result.");
    return { generation: result.generation, document: item.document as ManagedDocumentRecord<T> | null };
  }

  async readDocument(collection: string, document: ManagedDocumentRecord<any>, expectedGeneration: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(document.contentLength) || document.contentLength < 0 || document.contentLength > MAX_SCENE_BYTES) {
      throw new Error("The host returned an invalid document length.");
    }
    const bytes = new Uint8Array(document.contentLength);
    let offset = 0;
    while (offset < document.contentLength || document.contentLength === 0) {
      const result = await this.readSnapshot({
        expectedGeneration,
        reads: [{ kind: "document-content", collection, id: document.id, offset, length: MAX_CHUNK_BYTES }],
      });
      if (result.generation !== expectedGeneration) throw new DataV2ConflictError("Canvas changed while loading.");
      const item = result.results[0];
      if (item.kind !== "document-content" || item.offset !== offset || item.contentLength !== document.contentLength ||
        item.document.id !== document.id || item.document.revision !== document.revision || item.document.contentSha256 !== document.contentSha256 || item.document.contentLength !== document.contentLength) {
        throw new Error("The host returned an invalid document chunk.");
      }
      const chunk = decodeBase64(item.contentBase64);
      if (chunk.byteLength > MAX_CHUNK_BYTES || offset + chunk.byteLength > document.contentLength) throw new Error("The host returned an oversized document chunk.");
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
      if (offset === document.contentLength) break;
      if (chunk.byteLength === 0) throw new Error("The host returned an empty document chunk before completion.");
    }
    if (await sha256(bytes) !== document.contentSha256) throw new Error("The document checksum does not match host metadata.");
    return bytes;
  }

  async runBatch<T extends object>(input: {
    expectedGeneration: number;
    documents: DocumentMutation[];
    contents: Array<{ stageId: string; bytes: Uint8Array }>;
  }): Promise<BatchResult<T>> {
    let begin: BeginBatchResult | undefined;
    try {
      begin = await this.wire.beginBatch({
        mutationId: freshId(),
        expectedGeneration: input.expectedGeneration,
        operations: [],
        documents: input.documents,
      });
      const allocated = new Map(begin.documents.map(({ stageId, documentId }) => [stageId, documentId]));
      for (const content of input.contents) {
        const documentId = allocated.get(content.stageId);
        if (!documentId) throw new Error(`The host did not allocate document stage '${content.stageId}'.`);
        for (let offset = 0, chunkIndex = 0; offset < content.bytes.byteLength; offset += MAX_CHUNK_BYTES, chunkIndex += 1) {
          const chunk = content.bytes.slice(offset, offset + MAX_CHUNK_BYTES);
          await this.wire.appendDocumentChunk({ mutationId: freshId(), batchId: begin.batchId, documentId, chunkIndex, contentBase64: encodeBase64(chunk) });
        }
      }
      return await this.wire.commitBatch({ mutationId: freshId(), batchId: begin.batchId }) as BatchResult<T>;
    } catch (error) {
      try {
        if (begin) await this.wire.abortBatch({ mutationId: freshId(), batchId: begin.batchId });
      } catch {
        // Preserve the write failure; the host expires abandoned batches.
      }
      if (isConflict(error)) throw new DataV2ConflictError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

export async function encodeDocument(value: unknown): Promise<{ bytes: Uint8Array; contentSha256: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_SCENE_BYTES) throw new Error("The scene exceeds the 7 MiB storage limit.");
  return { bytes, contentSha256: await sha256(bytes) };
}

export function decodeDocument(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("The host returned invalid scene JSON.");
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return `sha256-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function freshId(): string {
  return globalThis.crypto.randomUUID();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The host returned invalid base64 content.");
  }
}

function isConflict(error: unknown): boolean {
  return /conflict|stale|compare-and-swap|generation|revision/i.test(error instanceof Error ? error.message : String(error));
}
