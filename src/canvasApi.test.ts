import { describe, expect, it } from "vitest";
import { CanvasRepository } from "./canvasApi";
import { createDataV2Adapter } from "./dataV2Adapter";
import { createScene } from "./semanticOperations";
import type { BoardDocument } from "./boardDocument";
import type { CanvasProposal } from "./proposals";
import { FakeDataV2, uuid } from "./test/fakeDataV2";

async function setup(title = "Original") {
  const fake = new FakeDataV2();
  await fake.seedCanvas(uuid(1), title, "original");
  const repository = new CanvasRepository(createDataV2Adapter(fake.host)!);
  const [canvas] = await repository.listCanvases();
  return { fake, repository, canvas };
}

const scene = () => createScene([{ type: "rectangle", id: "replacement" }]) as unknown as BoardDocument;
const proposal = (generation = 1): CanvasProposal => ({ artifactId: "proposal-1", title: "Add text", targetId: uuid(1), targetGeneration: generation, targetRevision: 1, operations: [{ kind: "add", element: { type: "text", id: "new", text: "Hello" } }] });

describe("canvas repository snapshot boundaries", () => {
  it("starts a fresh snapshot for each list, get and load after an external write", async () => {
    const { fake, repository } = await setup();
    fake.generation += 1;
    fake.documents.get(uuid(1)).metadata.title = "Changed elsewhere";
    expect((await repository.listCanvases())[0].title).toBe("Changed elsewhere");
    fake.generation += 1;
    expect((await repository.getCanvasMeta(uuid(1)))?.title).toBe("Changed elsewhere");
    fake.generation += 1;
    expect((await repository.loadCanvas(uuid(1)))?.scene.elements[0].id).toBe("original");
  });

  it("does not let unrelated generation changes block creating or saving", async () => {
    const { fake, repository, canvas } = await setup();
    fake.generation += 1;
    expect((await repository.createCanvas("New canvas")).canvas.title).toBe("New canvas");
    fake.generation += 1;
    expect((await repository.replaceCanvas(canvas, scene())).outcome).toBe("applied");
  });

  it("retains revision CAS when the same document changed externally", async () => {
    const { fake, repository, canvas } = await setup();
    fake.generation += 1;
    fake.documents.get(canvas.id).revision += 1;
    expect((await repository.replaceCanvas(canvas, scene())).outcome).toBe("conflict");
    expect(fake.commits).toHaveLength(0);
  });

  it("refuses mixed-generation chunks, then permits a fresh retry", async () => {
    const { fake, repository } = await setup();
    let changed = false;
    fake.beforeRead = async (request) => {
      if (!changed && request.reads[0].kind === "document-content") { fake.generation += 1; changed = true; }
    };
    await expect(repository.loadCanvas(uuid(1))).rejects.toThrow(/generation|conflict/i);
    expect((await repository.loadCanvas(uuid(1)))?.id).toBe(uuid(1));
  });

  it("checks the proposal generation against a new authoritative snapshot", async () => {
    const { fake, repository, canvas } = await setup();
    fake.generation += 1;
    expect((await repository.applyProposal(canvas, proposal())).outcome).toBe("stale");
    expect(fake.commits).toHaveLength(0);
  });

  it("never applies a proposal to a different canvas", async () => {
    const { fake, repository, canvas } = await setup();
    await expect(repository.applyProposal(canvas, { ...proposal(), targetId: uuid(2) })).rejects.toThrow(/target/i);
    expect(fake.commits).toHaveLength(0);
  });

  it("never applies a proposal to a trashed canvas", async () => {
    const { fake, repository } = await setup();
    fake.documents.get(uuid(1)).metadata.trashed_at = "2026-08-05T00:00:00Z";
    const canvas = (await repository.getCanvasMeta(uuid(1)))!;
    expect((await repository.applyProposal(canvas, proposal())).outcome).toBe("stale");
    expect(fake.commits).toHaveLength(0);
  });

  it("reports a removed target as not-found rather than a conflict with null", async () => {
    const { fake, repository, canvas } = await setup();
    fake.documents.delete(canvas.id);
    fake.generation += 1;
    expect((await repository.replaceCanvas(canvas, scene())).outcome).toBe("not-found");
  });

  it.each(["x".repeat(120), "🦅".repeat(30)])("duplicates maximum-byte titles without rejecting the generated name", async (title) => {
    const { repository, canvas } = await setup(title);
    const copy = await repository.manageCanvas(canvas, "duplicate");
    expect(copy.canvas?.title).toMatch(/^Copy of /);
    expect(new TextEncoder().encode(copy.canvas!.title).byteLength).toBeLessThanOrEqual(120);
    expect(copy.canvas?.title).not.toContain("�");
  });
});
