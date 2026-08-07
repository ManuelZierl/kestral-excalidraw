import { describe, expect, it } from "vitest";
import { CanvasSurfaceState, viewportFromAppState } from "./surfaceState";

describe("CanvasSurfaceState", () => {
  it("restores active canvas and viewport state", async () => {
    const host = new FakeStateHost();
    host.seed("active-canvas", { version: 1, canvas_id: "canvas-a" });
    host.seed("viewport:canvas-a", { version: 1, scroll_x: 12, scroll_y: -8, zoom: 2 });
    const state = new CanvasSurfaceState(host);

    expect(await state.readActiveCanvas()).toBe("canvas-a");
    expect(await state.readViewport("canvas-a")).toEqual({ scrollX: 12, scrollY: -8, zoom: 2 });
  });

  it("rejects malformed or unsafe viewport values", async () => {
    const host = new FakeStateHost();
    host.seed("viewport:wrong-shape", { version: 1, scroll_x: 0, scroll_y: 0, zoom: 1, dialog: "open" });
    host.seed("viewport:bad-zoom", { version: 1, scroll_x: 0, scroll_y: 0, zoom: 31 });
    const state = new CanvasSurfaceState(host);

    expect(await state.readViewport("wrong-shape")).toBeNull();
    expect(await state.readViewport("bad-zoom")).toBeNull();
    expect(viewportFromAppState({ scrollX: Number.NaN, scrollY: 0, zoom: { value: 1 } } as never)).toBeNull();
  });

  it("rereads and retries once after a stale revision", async () => {
    const host = new FakeStateHost();
    host.seed("active-canvas", { version: 1, canvas_id: "canvas-a" });
    const state = new CanvasSurfaceState(host);
    expect(await state.readActiveCanvas()).toBe("canvas-a");

    host.seed("active-canvas", { version: 1, canvas_id: "canvas-b" });
    await state.writeActiveCanvas("canvas-c");

    expect(await state.readActiveCanvas()).toBe("canvas-c");
  });

  it("serializes writes so the latest viewport wins", async () => {
    const host = new FakeStateHost();
    const state = new CanvasSurfaceState(host);

    await Promise.all([
      state.writeViewport("canvas-a", { scrollX: 1, scrollY: 2, zoom: 1 }),
      state.writeViewport("canvas-a", { scrollX: 3, scrollY: 4, zoom: 2 }),
    ]);

    expect(await state.readViewport("canvas-a")).toEqual({ scrollX: 3, scrollY: 4, zoom: 2 });
  });
});

class FakeStateHost {
  private readonly entries = new Map<string, { revision: number; value: Record<string, unknown> | null }>();

  seed(key: string, value: Record<string, unknown> | null) {
    const revision = (this.entries.get(key)?.revision ?? 0) + 1;
    this.entries.set(key, { revision, value });
  }

  async getState(key: string) {
    return structuredClone(this.entries.get(key) ?? { revision: 0, value: null });
  }

  async putState(key: string, expectedRevision: number, value: Record<string, unknown> | null) {
    const current = this.entries.get(key) ?? { revision: 0, value: null };
    if (current.revision !== expectedRevision) throw new Error("surface state revision conflict");
    const updated = { revision: current.revision + 1, value: structuredClone(value) };
    this.entries.set(key, updated);
    return structuredClone(updated);
  }
}
