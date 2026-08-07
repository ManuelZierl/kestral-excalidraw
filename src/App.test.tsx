import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeDocument } from "./dataV2Adapter";
import type { AppHostBridge } from "./hostBridge";

vi.mock("@excalidraw/excalidraw", async () => {
  const { useEffect } = await import("react");
  return {
    Excalidraw: ({ onChange, onScrollChange, excalidrawAPI, initialData, viewModeEnabled }: any) => {
      useEffect(() => excalidrawAPI?.(), [excalidrawAPI]);
      return <div data-testid="excalidraw">
        <span data-testid="scene-id">{String(initialData?.elements?.[0]?.id ?? "empty")}</span>
        <span data-testid="viewport">{`${initialData?.appState?.scrollX ?? 0},${initialData?.appState?.scrollY ?? 0},${initialData?.appState?.zoom?.value ?? 1}`}</span>
        <button type="button" disabled={viewModeEnabled} onClick={() => onChange([{ id: "changed" }], { scrollX: 12, scrollY: -8, zoom: { value: 2 } }, {})}>Make dirty</button>
        <button type="button" onClick={() => onScrollChange(12, -8, { value: 2 })}>Move view</button>
      </div>;
    },
    serializeAsJSON: (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => JSON.stringify({ elements, appState, files }),
  };
});

afterEach(() => { vi.useRealTimers(); cleanup(); delete window.appHost; vi.resetModules(); });

describe("document-only whiteboard", () => {
  it("saves a frontend scene through a staged document batch", async () => {
    const fake = new FakeDataV2();
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
    expect(fake.batches[1].documents[0].kind).toBe("replace");
    const saved = JSON.parse(new TextDecoder().decode([...fake.documents.values()][0].bytes));
    expect(saved.appState).not.toHaveProperty("scrollX");
    expect(saved.appState).not.toHaveProperty("scrollY");
    expect(saved.appState).not.toHaveProperty("zoom");
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("restores and independently persists the canvas viewport", async () => {
    const fake = new FakeDataV2();
    const firstCanvasId = uuid(1);
    fake.seedState(`viewport:${firstCanvasId}`, { version: 1, scroll_x: 20, scroll_y: -10, zoom: 1.5 });
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    expect(screen.getByTestId("viewport").textContent).toBe("20,-10,1.5");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Move view" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await vi.waitFor(() => expect(fake.state.get(`viewport:${firstCanvasId}`)?.value).toEqual({ version: 1, scroll_x: 12, scroll_y: -8, zoom: 2 }));
    expect(fake.commits).toHaveLength(1);
    expect(fake.state.get("active-canvas")?.value).toEqual({ version: 1, canvas_id: firstCanvasId });
  });

  it("reopens the last active non-trashed canvas", async () => {
    const fake = new FakeDataV2();
    const firstCanvasId = uuid(1);
    const secondCanvasId = uuid(2);
    await fake.seedCanvas(firstCanvasId, "First canvas", "first-scene");
    await fake.seedCanvas(secondCanvasId, "Second canvas", "second-scene");
    fake.seedState("active-canvas", { version: 1, canvas_id: secondCanvasId });
    window.appHost = fake.host;
    const { default: App } = await import("./App");

    render(<App />);

    expect((await screen.findByTestId("scene-id")).textContent).toBe("second-scene");
    expect(fake.state.get("active-canvas")).toEqual({ revision: 1, value: { version: 1, canvas_id: secondCanvasId } });
  });

  it("keeps the editor dirty and exposes CAS conflict recovery", async () => {
    const fake = new FakeDataV2();
    fake.conflictOnReplace = true;
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    await vi.waitFor(() => expect(screen.getByText("This canvas changed elsewhere.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Keep mine as copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard mine and reload" })).toBeTruthy();
  });

  it("reviews a proposal and records rejection through metadata-only CAS", async () => {
    const fake = new FakeDataV2();
    fake.proposalEnabled = true;
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("Review canvas proposal");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(screen.queryByText("Review canvas proposal")).toBeNull());
    expect([...fake.documents.values()][0].metadata.applied_proposals[0].status).toBe("rejected");
    expect(fake.batches.at(-1).documents[0].kind).toBe("update-metadata");
    window.dispatchEvent(new Event("focus"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByText("Review canvas proposal")).toBeNull();
  });

  it("applies a proposal through frontend semantic operations and records a receipt", async () => {
    const fake = new FakeDataV2();
    fake.proposalEnabled = true;
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("Review canvas proposal");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect([...fake.documents.values()][0].metadata.applied_proposals[0].status).toBe("applied"));
    expect(screen.queryByText("Review canvas proposal")).toBeNull();
  });

  it("visibly refuses a stale proposal without mutating the canvas", async () => {
    const fake = new FakeDataV2();
    fake.proposalEnabled = true;
    fake.proposalStale = true;
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("Review canvas proposal");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("stale"));
    expect([...fake.documents.values()][0].metadata.applied_proposals).toHaveLength(0);
  });
});

class FakeDataV2 {
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
  private init: ((context: { theme: "light" | "dark" | null; variables: Record<string, string> }) => void) | null = null;

  constructor() {
    const wire = {
      readSnapshot: async (request: any) => this.readSnapshot(request),
      beginBatch: async (request: any) => {
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
      invoke: async () => ({}), invokeScoped: async () => ({}), listArtifacts: async () => this.proposalEnabled ? [this.proposal()] : [], data: { v2: wire },
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
    const scene = { type: "kestral-excalidraw", version: 1, editor: "excalidraw", elements: [{ id: sceneId }], appState: {}, files: {} };
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
    const read = request.reads[0];
    if (read.kind === "document-list") return { generation: this.generation, results: [{ kind: "document-list", documents: [...this.documents.values()].map(publicDocument), nextAfter: null }] };
    const document = this.documents.get(read.id) ?? null;
    if (read.kind === "document-get") return { generation: this.generation, results: [{ kind: "document-get", document: document ? publicDocument(document) : null }] };
    const content = document.bytes.slice(read.offset, read.offset + read.length);
    return { generation: this.generation, results: [{ kind: "document-content", document: publicDocument(document), offset: read.offset, contentBase64: toBase64(content), contentLength: document.contentLength }] };
  }

  private async commitBatch(batchId: string) {
    const batch = this.batches.find((candidate) => candidate.id === batchId);
    const touched: any[] = [];
    for (const stage of batch.documents) {
      const id = batch.staged.get(stage.stageId) ?? stage.id;
      const current = this.documents.get(id);
      if (stage.kind === "delete") { this.documents.delete(id); continue; }
      if ((stage.kind === "replace" || stage.kind === "update-metadata") && (!current || current.revision !== stage.expectedRevision)) throw new Error("revision conflict");
      if (this.conflictOnReplace && stage.kind === "replace") { this.conflictOnReplace = false; throw new Error("revision conflict"); }
      const bytes = stage.kind === "update-metadata" ? current.bytes : concat(batch.chunks.get(id) ?? []);
      const document = { id, revision: current ? current.revision + 1 : 1, createdAt: current?.createdAt ?? now(), updatedAt: now(), metadata: stage.metadata, contentSha256: stage.kind === "update-metadata" ? current.contentSha256 : stage.contentSha256, contentLength: bytes.length, bytes };
      this.documents.set(id, document); touched.push(publicDocument(document));
    }
    this.generation += 1;
    const result = { generation: this.generation, records: [], documents: touched };
    this.commits.push(result);
    return result;
  }
}

function publicDocument(document: any) { const { bytes: _bytes, ...metadata } = document; return metadata; }
function concat(chunks: Uint8Array[]) { const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0)); let offset = 0; for (const chunk of chunks) { if (!chunk) continue; result.set(chunk, offset); offset += chunk.length; } return result; }
function uuid(seed: number) { return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`; }
function now() { return "2026-08-05T00:00:00.000Z"; }
function toBase64(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
