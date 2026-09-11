import { describe, expect, it } from "vitest";
import { DataV2Adapter, DataV2ConflictError, MAX_CHUNK_BYTES, MAX_SCENE_BYTES, encodeDocument, type ManagedDocumentRecord } from "./dataV2Adapter";

describe("data.v2 adapter", () => {
  it("uses the exact snapshot wire and reads bounded 7 MiB content", async () => {
    const wire = new RecordingWire();
    const content = new Uint8Array(MAX_SCENE_BYTES).fill(65);
    const encoded = await encodeDocument({ bytes: "x".repeat(100) });
    await wire.adapter.runBatch({
      expectedGeneration: 7,
      documents: [{ kind: "create", stageId: "scene", collection: "canvases", metadata: {}, contentLength: content.byteLength, contentSha256: `sha256-${"a".repeat(64)}` }],
      contents: [{ stageId: "scene", bytes: content }],
    });
    expect(wire.beginRequest).toMatchObject({ expectedGeneration: 7, operations: [], documents: [{ kind: "create", stageId: "scene", contentLength: MAX_SCENE_BYTES }] });
    expect(wire.chunks).toHaveLength(Math.ceil(MAX_SCENE_BYTES / MAX_CHUNK_BYTES));
    expect(Math.max(...wire.chunks.map((chunk) => chunk.length))).toBe(MAX_CHUNK_BYTES);
    expect(wire.committed).toBe(true);
    expect(encoded.contentSha256).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("aborts a batch after an append failure", async () => {
    const wire = new RecordingWire();
    wire.failAppend = true;
    await expect(wire.adapter.runBatch({
      expectedGeneration: 1,
      documents: [{ kind: "create", stageId: "scene", collection: "canvases", metadata: {}, contentLength: 1, contentSha256: `sha256-${"b".repeat(64)}` }],
      contents: [{ stageId: "scene", bytes: new Uint8Array([1]) }],
    })).rejects.toThrow(/append failed/);
    expect(wire.aborted).toBe(true);
  });

  it("validates exact document-content results and host-owned hashes", async () => {
    const value = { type: "kestral-excalidraw", version: 1, editor: "excalidraw", elements: [], appState: {}, files: { payload: "x".repeat(1024 * 1024) } };
    const encoded = await encodeDocument(value);
    const wire = new RecordingWire(encoded.bytes, encoded.contentSha256);
    const metadata: ManagedDocumentRecord = { id: "00000000-0000-4000-8000-000000000001", revision: 2, createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", metadata: {}, contentSha256: encoded.contentSha256, contentLength: encoded.bytes.byteLength };
    const loaded = await wire.adapter.readDocument("canvases", metadata, 1);
    expect(loaded.byteLength).toBe(encoded.bytes.byteLength);
    const fullChunks = Math.floor(encoded.bytes.byteLength / MAX_CHUNK_BYTES);
    const finalChunk = encoded.bytes.byteLength % MAX_CHUNK_BYTES;
    expect(wire.readLengths).toEqual([
      ...Array(fullChunks).fill(MAX_CHUNK_BYTES),
      ...(finalChunk === 0 ? [] : [finalChunk]),
    ]);
  });

  it("does not request content beyond a short document", async () => {
    const encoded = await encodeDocument({ elements: [] });
    const wire = new RecordingWire(encoded.bytes, encoded.contentSha256);
    const metadata: ManagedDocumentRecord = { id: "00000000-0000-4000-8000-000000000001", revision: 2, createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", metadata: {}, contentSha256: encoded.contentSha256, contentLength: encoded.bytes.byteLength };
    const loaded = await wire.adapter.readDocument("canvases", metadata, 1);
    expect([...loaded]).toEqual([...encoded.bytes]);
    expect(wire.readLengths).toEqual([encoded.bytes.byteLength]);
  });

  it("returns a valid empty document without requesting a chunk", async () => {
    const emptyHash = "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const wire = new RecordingWire(new Uint8Array(), emptyHash);
    const metadata: ManagedDocumentRecord = { id: "00000000-0000-4000-8000-000000000001", revision: 2, createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", metadata: {}, contentSha256: emptyHash, contentLength: 0 };
    await expect(wire.adapter.readDocument("canvases", metadata, 1)).resolves.toEqual(new Uint8Array());
    expect(wire.readLengths).toEqual([]);
  });

  it("rejects a snapshot whose returned generation differs from the request", async () => {
    const wire = new RecordingWire();
    await expect(wire.adapter.listDocuments("canvases", 7)).rejects.toBeInstanceOf(DataV2ConflictError);
    await expect(wire.adapter.getDocument("canvases", "id", 7)).rejects.toBeInstanceOf(DataV2ConflictError);
  });

  it("rejects chunks attributed to another document revision even when their bytes match", async () => {
    const encoded = await encodeDocument({ elements: [] });
    const wire = new RecordingWire(encoded.bytes, encoded.contentSha256);
    const selected: ManagedDocumentRecord = { id: "00000000-0000-4000-8000-000000000001", revision: 3, createdAt: "", updatedAt: "", metadata: {}, contentLength: encoded.bytes.length, contentSha256: encoded.contentSha256 };
    await expect(wire.adapter.readDocument("canvases", selected, 1)).rejects.toThrow(/chunk/);
  });

});

class RecordingWire {
  readonly adapter: DataV2Adapter;
  readonly chunks: Uint8Array[] = [];
  readonly readLengths: number[] = [];
  beginRequest: any;
  committed = false;
  aborted = false;
  failAppend = false;
  private readonly content: Uint8Array<ArrayBufferLike>;
  private readonly contentHash: string;

  constructor(content: Uint8Array<ArrayBufferLike> = new Uint8Array() as Uint8Array<ArrayBufferLike>, contentHash = `sha256-${"0".repeat(64)}`) {
    this.content = content;
    this.contentHash = contentHash;
    this.adapter = new DataV2Adapter({
      readSnapshot: async (request) => {
        const read = request.reads[0];
        if (read.kind === "document-content") {
          this.readLengths.push(read.length);
          if (read.length > MAX_CHUNK_BYTES || read.offset + read.length > this.content.byteLength) {
            throw new Error(`managed-data document chunk must be at most ${MAX_CHUNK_BYTES} bytes and within the document`);
          }
          const chunk = this.content.slice(read.offset, read.offset + read.length);
          return { generation: 1, results: [{ kind: "document-content", document: this.document(), offset: read.offset, contentBase64: toBase64(chunk), contentLength: this.content.byteLength }] };
        }
        return { generation: 1, results: [{ kind: "document-list", documents: [], nextAfter: null }] };
      },
      beginBatch: async (request) => { this.beginRequest = request; return { batchId: "batch-1", generation: 8, documents: [{ stageId: "scene", documentId: "00000000-0000-4000-8000-000000000001" }] }; },
      appendDocumentChunk: async (request) => { if (this.failAppend) throw new Error("append failed"); this.chunks[request.chunkIndex] = fromBase64(request.contentBase64); },
      commitBatch: async () => { this.committed = true; return { generation: 8, records: [], documents: [this.document()] }; },
      abortBatch: async () => { this.aborted = true; },
    });
  }

  private document(): ManagedDocumentRecord {
    return { id: "00000000-0000-4000-8000-000000000001", revision: 2, createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", metadata: {}, contentSha256: this.contentHash, contentLength: this.content.byteLength };
  }
}

function toBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
