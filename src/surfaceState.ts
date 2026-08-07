import type { AppState } from "@excalidraw/excalidraw/types";
import type { AppHostBridge, SurfaceStateEntry } from "./hostBridge";

const ACTIVE_CANVAS_KEY = "active-canvas";
const VIEWPORT_KEY_PREFIX = "viewport:";
const STATE_VERSION = 1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

export interface CanvasViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export class CanvasSurfaceState {
  private readonly revisions = new Map<string, number>();
  private readonly values = new Map<string, Record<string, unknown> | null>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly host: Pick<AppHostBridge, "getState" | "putState">) {}

  async readActiveCanvas(): Promise<string | null> {
    const entry = await this.readEntry(ACTIVE_CANVAS_KEY);
    return parseActiveCanvas(entry.value);
  }

  async writeActiveCanvas(canvasId: string): Promise<void> {
    await this.write(ACTIVE_CANVAS_KEY, { version: STATE_VERSION, canvas_id: canvasId });
  }

  async readViewport(canvasId: string): Promise<CanvasViewport | null> {
    const entry = await this.readEntry(viewportKey(canvasId));
    return parseViewport(entry.value);
  }

  async writeViewport(canvasId: string, viewport: CanvasViewport): Promise<void> {
    await this.write(viewportKey(canvasId), {
      version: STATE_VERSION,
      scroll_x: viewport.scrollX,
      scroll_y: viewport.scrollY,
      zoom: viewport.zoom,
    });
  }

  private async readEntry(key: string): Promise<SurfaceStateEntry> {
    const entry = validateEntry(await this.host.getState(key));
    this.revisions.set(key, entry.revision);
    this.values.set(key, entry.value);
    return entry;
  }

  private async write(key: string, value: Record<string, unknown>): Promise<void> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.writeNow(key, value));
    this.writes.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.writes.get(key) === operation) this.writes.delete(key);
    }
  }

  private async writeNow(key: string, value: Record<string, unknown>): Promise<void> {
    if (!this.revisions.has(key)) await this.readEntry(key);
    if (sameValue(this.values.get(key) ?? null, value)) return;
    try {
      const updated = validateEntry(await this.host.putState(key, this.revisions.get(key)!, value));
      this.revisions.set(key, updated.revision);
      this.values.set(key, updated.value);
      return;
    } catch (firstError) {
      const current = await this.readEntry(key).catch(() => { throw firstError; });
      if (sameValue(current.value, value)) return;
      const updated = validateEntry(await this.host.putState(key, current.revision, value));
      this.revisions.set(key, updated.revision);
      this.values.set(key, updated.value);
    }
  }
}

export function viewportFromAppState(appState: AppState): CanvasViewport | null {
  const zoom = isRecord(appState.zoom) ? appState.zoom.value : null;
  const candidate = {
    version: STATE_VERSION,
    scroll_x: appState.scrollX,
    scroll_y: appState.scrollY,
    zoom,
  };
  return parseViewport(candidate);
}

export function applyViewport(appState: Partial<AppState>, viewport: CanvasViewport | null): Partial<AppState> {
  if (!viewport) return appState;
  return {
    ...appState,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    zoom: { value: viewport.zoom } as AppState["zoom"],
  };
}

function viewportKey(canvasId: string): string {
  return `${VIEWPORT_KEY_PREFIX}${canvasId}`;
}

function parseActiveCanvas(value: Record<string, unknown> | null): string | null {
  if (!hasExactKeys(value, ["canvas_id", "version"])) return null;
  return value.version === STATE_VERSION && typeof value.canvas_id === "string" && value.canvas_id.length > 0
    ? value.canvas_id
    : null;
}

function parseViewport(value: Record<string, unknown> | null): CanvasViewport | null {
  if (!hasExactKeys(value, ["scroll_x", "scroll_y", "version", "zoom"])) return null;
  if (
    value.version !== STATE_VERSION ||
    !isFiniteNumber(value.scroll_x) ||
    !isFiniteNumber(value.scroll_y) ||
    !isFiniteNumber(value.zoom) ||
    value.zoom < MIN_ZOOM ||
    value.zoom > MAX_ZOOM
  ) return null;
  return { scrollX: value.scroll_x, scrollY: value.scroll_y, zoom: value.zoom };
}

function validateEntry(value: unknown): SurfaceStateEntry {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("Kestral returned an invalid surface-state revision.");
  }
  if (value.value !== null && !isRecord(value.value)) {
    throw new Error("Kestral returned an invalid surface-state value.");
  }
  return { revision: value.revision as number, value: value.value as Record<string, unknown> | null };
}

function sameValue(left: Record<string, unknown> | null, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
