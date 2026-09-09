import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDataV2, uuid, testElement, deferred } from "./test/fakeDataV2";

vi.mock("@excalidraw/excalidraw", async () => {
  const { useEffect } = await import("react");
  return {
    Excalidraw: ({ onChange, onScrollChange, excalidrawAPI, initialData, viewModeEnabled }: any) => {
      useEffect(() => excalidrawAPI?.(), [excalidrawAPI]);
      return <div data-testid="excalidraw">
        <span data-testid="scene-id">{String(initialData?.elements?.[0]?.id ?? "empty")}</span>
        <span data-testid="viewport">{`${initialData?.appState?.scrollX ?? 0},${initialData?.appState?.scrollY ?? 0},${initialData?.appState?.zoom?.value ?? 1}`}</span>
        <button type="button" disabled={viewModeEnabled} onClick={() => onChange([testElement("changed")], { scrollX: 12, scrollY: -8, zoom: { value: 2 } }, {})}>Make dirty</button>
        <button type="button" disabled={viewModeEnabled} onClick={() => onChange([testElement("newer")], {}, {})}>Make newer edit</button>
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


describe("whiteboard edit and refresh races", () => {
  async function mount(fake: FakeDataV2) {
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByTestId("excalidraw");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  it("does not overwrite pending manual edits when Apply is clicked", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "First", "original");
    fake.proposalEnabled = true;
    await mount(fake);
    await screen.findByText("Review canvas proposal");
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/stale|unsaved/i));
    const saved = JSON.parse(new TextDecoder().decode(fake.documents.get(uuid(1)).bytes));
    expect(saved.elements[0].id).toBe("changed");
    expect(fake.documents.get(uuid(1)).metadata.applied_proposals).toHaveLength(0);
  });

  it("can autosave immediately after rejecting a proposal", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "First", "original");
    fake.proposalEnabled = true;
    await mount(fake);
    await screen.findByText("Review canvas proposal");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(screen.queryByText("Review canvas proposal")).toBeNull());
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
    expect(fake.documents.get(uuid(1)).metadata.applied_proposals[0].status).toBe("rejected");
    expect(screen.queryByText("This canvas changed elsewhere.")).toBeNull();
  });

  it("refreshes externally changed canvases repeatedly, not just at startup", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "First", "original");
    await mount(fake);
    fake.documents.get(uuid(1)).metadata.title = "External title";
    fake.documents.get(uuid(1)).revision += 1;
    fake.generation += 1;
    await act(async () => { fake.events.forEach((callback) => callback()); });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /External title.*r2/ })).toBeTruthy());
    expect(fake.host.reportError).not.toHaveBeenCalled();
  });

  it("does not discard edits made while another canvas is loading", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "First", "first");
    await fake.seedCanvas(uuid(2), "Second", "second");
    await mount(fake);
    const loading = deferred();
    fake.beforeRead = async (request) => { if (request.reads[0].id === uuid(2)) await loading.promise; };
    fireEvent.click(screen.getByRole("button", { name: /Second.*r1/ }));
    await act(async () => {});
    const edit = screen.getByRole("button", { name: "Make dirty" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    fireEvent.click(edit);
    await act(async () => { loading.resolve(); });
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).not.toContain("Opening canvas"));
    expect(screen.getByTestId("scene-id").textContent).toBe("second");
  });

  it("creates a full conflict copy in one batch even at the title byte limit", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "😀".repeat(30), "original");
    fake.conflictOnReplace = true;
    await mount(fake);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Make dirty" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Keep mine as copy" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep mine as copy" }));
    await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
    const copy = fake.documents.get(uuid(2));
    expect(new TextEncoder().encode(copy.metadata.title).length).toBeLessThanOrEqual(120);
    expect(copy.metadata.title).toContain("(conflict copy)");
    expect(JSON.parse(new TextDecoder().decode(copy.bytes)).elements[0].id).toBe("changed");
    expect(fake.batches.at(-1).documents[0].kind).toBe("create");
    await vi.waitFor(() => expect(screen.getByTestId("scene-id").textContent).toBe("changed"));
  });

  it("retains proposal cards after host events and does not resurrect a rejected card from an old refresh", async () => {
    const fake = new FakeDataV2();
    await fake.seedCanvas(uuid(1), "First", "original");
    fake.proposalEnabled = true;
    await mount(fake);
    await screen.findByText("Review canvas proposal");
    await act(async () => { fake.events.forEach((callback) => callback()); });
    expect(screen.getByText("Review canvas proposal")).toBeTruthy();
    const artifacts = await fake.host.listArtifacts();
    const pending = deferred<typeof artifacts>();
    fake.host.listArtifacts = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(artifacts);
    await act(async () => { fake.events.forEach((callback) => callback()); });
    await vi.waitFor(() => expect(fake.host.listArtifacts).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await vi.waitFor(() => expect(screen.queryByText("Review canvas proposal")).toBeNull());
    await act(async () => { pending.resolve(artifacts); });
    expect(screen.queryByText("Review canvas proposal")).toBeNull();
  });

  it("ignores callbacks after unmount and repeated initialization does not create another canvas", async () => {
    const fake = new FakeDataV2();
    window.appHost = fake.host;
    const { default: App } = await import("./App");
    const mounted = render(<App />);
    await screen.findByTestId("excalidraw");
    await act(async () => { fake.host.ready(); });
    expect(fake.documents.size).toBe(1);
    mounted.unmount();
    const reads = fake.reads.length;
    await act(async () => { fake.events.forEach((callback) => callback()); fake.host.ready(); });
    expect(fake.reads).toHaveLength(reads);
    expect(fake.documents.size).toBe(1);
  });

});
