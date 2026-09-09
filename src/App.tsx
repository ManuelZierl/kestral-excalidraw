import { Excalidraw } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState } from "react";
import {
  type CanvasMeta,
} from "./canvasApi";
import { CanvasRepository, deriveCopyTitle } from "./canvasApi";
import { createDataV2Adapter, MAX_TITLE_BYTES } from "./dataV2Adapter";
import { validateProposalArtifact, type CanvasProposal } from "./proposals";
import {
  createBoardDocument,
  parseBoardDocument,
  type BoardDocument,
  type SceneElements,
} from "./boardDocument";
import {
  applyViewport,
  CanvasSurfaceState,
  viewportFromAppState,
  type CanvasViewport,
} from "./surfaceState";

type SaveState = "clean" | "dirty" | "saving";
type DialogState =
  | { kind: "title"; mode: "create" | "rename"; canvas: CanvasMeta | null; value: string }
  | { kind: "trash"; canvas: CanvasMeta }
  | { kind: "purge"; canvas: CanvasMeta }
  | null;

interface LoadedScene {
  key: string;
  initialData: ExcalidrawInitialDataState;
}

const host = window.appHost;
const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";
const AUTOSAVE_DELAY_MS = 750;
const VIEWPORT_SAVE_DELAY_MS = 350;

export default function App() {
  const [canvases, renderCanvases] = useState<CanvasMeta[]>([]);
  const canvasesRef = useRef<CanvasMeta[]>([]);
  const repositoryRef = useRef<CanvasRepository | null>(null);
  const actionBusyRef = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const proposalRefreshGenerationRef = useRef(0);

  function setCanvases(next: CanvasMeta[] | ((items: CanvasMeta[]) => CanvasMeta[])) {
    const items = typeof next === "function" ? next(canvasesRef.current) : next;
    canvasesRef.current = items;
    renderCanvases(items);
  }

  function requireRepository(): CanvasRepository {
    if (!repositoryRef.current) throw new Error("Kestral data.v2 is unavailable in this surface.");
    return repositoryRef.current;
  }
  const [current, setCurrent] = useState<CanvasMeta | null>(null);
  const [loadedScene, setLoadedScene] = useState<LoadedScene | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [status, setStatus] = useState("Connecting to Kestral...");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showTrash, setShowTrash] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [externalConflict, setExternalConflict] = useState<CanvasMeta | null | undefined>();
  const documentRef = useRef<BoardDocument | null>(null);
  const documentFingerprintRef = useRef<string | null>(null);
  const savedFingerprintRef = useRef<string | null>(null);
  const editorInitializedRef = useRef(false);
  const currentRef = useRef<CanvasMeta | null>(null);
  const saveStateRef = useRef<SaveState>("clean");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingViewportRef = useRef<{ canvasId: string; viewport: CanvasViewport } | null>(null);
  const surfaceStateRef = useRef<CanvasSurfaceState | null>(null);
  const disposedRef = useRef(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const openGenerationRef = useRef(0);
  const refreshingRef = useRef(false);
  const conflictRecoveryRef = useRef(false);
  const [conflictRecoveryBusy, setConflictRecoveryBusy] = useState(false);
  const [pendingProposals, setPendingProposals] = useState<CanvasProposal[]>([]);
  const [proposalBusy, setProposalBusy] = useState<string | null>(null);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    let active = true;
    let started = false;
    disposedRef.current = false;

    async function start() {
      if (!active) return;
      if (!host) {
        const preview = previewCanvas();
        setCanvases([preview]);
        setCurrent(preview);
        setLoadedScene({ key: "preview", initialData: {} });
        setStatus("Development preview: changes are not persisted.");
        return;
      }
      try {
        const data = createDataV2Adapter(host);
        if (!data) throw new Error("Kestral data.v2 is unavailable in this surface.");
        repositoryRef.current = new CanvasRepository(data);
        surfaceStateRef.current = new CanvasSurfaceState(host);
        let preferredCanvasId: string | null = null;
        let viewRestoreFailed = false;
        try {
          preferredCanvasId = await surfaceStateRef.current.readActiveCanvas();
        } catch (error) {
          viewRestoreFailed = true;
          host.reportError(`Could not restore the previous Whiteboard canvas: ${errorMessage(error)}`);
        }
        if (!active) return;
        const listed = await fetchAllCanvases();
        if (!active) return;
        setCanvases(listed);
        const first = listed.find((canvas) => canvas.id === preferredCanvasId && canvas.trashed_at === null)
          ?? listed.find((canvas) => canvas.trashed_at === null);
        if (first) {
          await openCanvas(first.id);
        } else {
          await createCanvas("Untitled canvas");
        }
        if (!active) return;
        await refreshProposals();
        if (viewRestoreFailed) setStatus("Canvas opened, but its previous view could not be restored.");
      } catch (error) {
        reportFailure("Whiteboard unavailable", error);
      }
    }

    if (host) {
      host.onInit((context) => {
        if (!active) return;
        setTheme(context.theme === "dark" ? "dark" : "light");
        if (started) return;
        started = true;
        void start();
      });
      host.onEvent(() => {
        if (active) void refreshFromHost();
      });
      host.ready();
    } else {
      void start();
    }

    const themeObserver = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") {
        void refreshFromHost();
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    return () => {
      active = false;
      disposedRef.current = true;
      themeObserver.disconnect();
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
      clearAutosaveTimer();
      clearViewportTimer();
      pendingViewportRef.current = null;
      openGenerationRef.current += 1;
      proposalRefreshGenerationRef.current += 1;
    };
  }, []);

  async function fetchAllCanvases(): Promise<CanvasMeta[]> {
    const repository = repositoryRef.current;
    if (!repository) return [previewCanvas()];
    return repository.listCanvases();
  }

  async function refreshProposals(listed = canvasesRef.current) {
    if (!host || disposedRef.current) return;
    const generation = ++proposalRefreshGenerationRef.current;
    try {
      const artifacts = await host.listArtifacts();
      if (disposedRef.current || generation !== proposalRefreshGenerationRef.current) return;
      const valid: CanvasProposal[] = [];
      for (const artifact of artifacts) {
        if (artifact.artifact_type !== "canvas-operations-proposal") continue;
        try {
          const proposal = validateProposalArtifact(artifact, "com.ma-zierl.kestral-excalidraw", "canvases");
          const target = listed.find((canvas) => canvas.id === proposal.targetId);
          if (target && !target.metadata.applied_proposals.some((receipt) => receipt.proposal_id === proposal.artifactId)) valid.push(proposal);
        } catch (error) {
          setStatus(`Ignored invalid canvas proposal: ${errorMessage(error)}`);
          host.reportError(`Ignored invalid canvas proposal: ${errorMessage(error)}`);
        }
      }
      setPendingProposals(valid);
    } catch (error) {
      if (disposedRef.current || generation !== proposalRefreshGenerationRef.current) return;
      reportFailure("Proposal refresh failed", error);
    }
  }

  async function refreshFromHost() {
    const repository = repositoryRef.current;
    if (!repository || disposedRef.current || refreshingRef.current || actionBusyRef.current || conflictRecoveryRef.current || readSaveState() === "saving") return;
    refreshingRef.current = true;
    const selectedBeforeRefresh = currentRef.current;
    const openGeneration = openGenerationRef.current;
    try {
      const listed = await fetchAllCanvases();
      if (disposedRef.current || actionBusyRef.current || conflictRecoveryRef.current) return;
      const selectedAfterRefresh = currentRef.current;
      setCanvases(listed.map((canvas) => {
        return selectedAfterRefresh?.id === canvas.id && selectedAfterRefresh.revision > canvas.revision
          ? selectedAfterRefresh
          : canvas;
      }));
      await refreshProposals(listed);
      if (
        disposedRef.current || actionBusyRef.current || conflictRecoveryRef.current ||
        openGenerationRef.current !== openGeneration ||
        selectedBeforeRefresh?.id !== selectedAfterRefresh?.id ||
        selectedBeforeRefresh?.revision !== selectedAfterRefresh?.revision
      ) return;
      const selected = currentRef.current;
      if (!selected) return;
      const latest = listed.find((canvas) => canvas.id === selected.id);
      if (!latest) {
        const refreshSaveState = readSaveState();
        if (refreshSaveState !== "clean") {
          if (refreshSaveState === "saving") return;
          setExternalConflict(null);
          setStatus("This canvas was removed elsewhere. Keep your work as a copy or discard it.");
        } else {
          const fallback = listed.find((canvas) => canvas.trashed_at === null);
          if (fallback) await openCanvas(fallback.id);
          else await createCanvas("Untitled canvas");
        }
        return;
      }
      if (latest.trashed_at !== null) {
        const refreshSaveState = readSaveState();
        if (refreshSaveState !== "clean") {
          if (refreshSaveState === "saving") return;
          setExternalConflict(null);
          setStatus("This canvas was moved to trash elsewhere. Keep your work as a copy or discard it.");
        } else {
          const fallback = listed.find((canvas) => canvas.id !== latest.id && canvas.trashed_at === null);
          if (fallback) await openCanvas(fallback.id);
          else await createCanvas("Untitled canvas");
        }
        return;
      }
      if (latest.revision < selected.revision) return;
      if (latest.revision === selected.revision) return;
      const refreshSaveState = readSaveState();
      if (refreshSaveState !== "clean") {
        if (refreshSaveState === "saving") return;
        setExternalConflict(latest);
        setStatus("This canvas changed elsewhere. Your unsaved work has not been overwritten.");
      } else {
        await openCanvas(latest.id);
      }
    } catch (error) {
      reportFailure("Refresh failed", error);
    } finally {
      refreshingRef.current = false;
    }
  }

  async function openCanvas(id: string): Promise<boolean> {
    const repository = repositoryRef.current;
    if (!repository) return false;
    const generation = ++openGenerationRef.current;
    const selectedAtStart = currentRef.current;
    const fingerprintAtStart = documentFingerprintRef.current;
    await flushViewport();
    if (generation !== openGenerationRef.current) return false;
    clearAutosaveTimer();
    setStatus("Opening canvas...");
    try {
      const result = await repository.loadCanvas(id);
      if (!result) throw new Error("Canvas no longer exists.");
      if (result.trashed_at !== null) throw new Error("Canvas is in trash.");
      const scene = parseBoardDocument(result.scene);
      let viewport: CanvasViewport | null = null;
      let viewRestoreFailed = false;
      try {
        viewport = await surfaceStateRef.current?.readViewport(id) ?? null;
      } catch (error) {
        viewRestoreFailed = true;
        host?.reportError(`Could not restore the view for ${result.title}: ${errorMessage(error)}`);
      }
      if (generation !== openGenerationRef.current) return false;
      if (currentRef.current?.id !== selectedAtStart?.id || currentRef.current?.revision !== selectedAtStart?.revision || documentFingerprintRef.current !== fingerprintAtStart) {
        setStatus("Canvas changed while loading. Your latest editor state was kept.");
        if (readSaveState() === "dirty") scheduleAutosave();
        return false;
      }
      const fingerprint = documentFingerprint(scene);
      editorInitializedRef.current = false;
      documentRef.current = scene;
      documentFingerprintRef.current = fingerprint;
      savedFingerprintRef.current = fingerprint;
      currentRef.current = result;
      setCurrent(result);
      setLoadedScene({
        key: `${result.id}:${result.revision}`,
        initialData: { elements: scene.elements, appState: applyViewport(scene.appState, viewport), files: scene.files },
      });
      updateSaveState("clean");
      setExternalConflict(undefined);
      setNavigatorOpen(false);
      setStatus(viewRestoreFailed
        ? `Opened ${result.title}, but its previous view could not be restored.`
        : `Saved ${formatTimestamp(result.updated_at)}.`);
      void persistActiveCanvas(result.id);
      return true;
    } catch (error) {
      if (generation !== openGenerationRef.current) return false;
      throw error;
    }
  }

  function handleChange(elements: SceneElements, appState: AppState, files: BinaryFiles) {
    const nextDocument = createBoardDocument(elements, appState, files);
    const nextFingerprint = documentFingerprint(nextDocument);
    const changed = nextFingerprint !== documentFingerprintRef.current;
    documentRef.current = nextDocument;
    documentFingerprintRef.current = nextFingerprint;
    if (!editorInitializedRef.current) return;
    if (!changed) return;
    if (nextFingerprint === savedFingerprintRef.current) {
      if (saveStateRef.current !== "saving") {
        clearAutosaveTimer();
        updateSaveState("clean");
      }
      return;
    }
    if (saveStateRef.current !== "saving") updateSaveState("dirty");
    setStatus(host ? "Changes pending autosave..." : "Development preview: changes are not persisted.");
    scheduleAutosave();
  }

  function handleViewportChange(scrollX: number, scrollY: number, zoom: AppState["zoom"]) {
    const selected = currentRef.current;
    if (!host || !selected || !editorInitializedRef.current) return;
    const viewport = viewportFromAppState({ scrollX, scrollY, zoom } as AppState);
    if (!viewport) return;
    pendingViewportRef.current = { canvasId: selected.id, viewport };
    clearViewportTimer();
    viewportTimerRef.current = setTimeout(() => {
      viewportTimerRef.current = null;
      void flushViewport();
    }, VIEWPORT_SAVE_DELAY_MS);
  }

  async function persistActiveCanvas(canvasId: string) {
    try {
      await surfaceStateRef.current?.writeActiveCanvas(canvasId);
    } catch (error) {
      reportViewFailure("The active canvas was not saved", error);
    }
  }

  async function flushViewport() {
    clearViewportTimer();
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (!pending || disposedRef.current) return;
    try {
      await surfaceStateRef.current?.writeViewport(pending.canvasId, pending.viewport);
    } catch (error) {
      reportViewFailure("The canvas position was not saved", error);
    }
  }

  function clearViewportTimer() {
    if (viewportTimerRef.current === null) return;
    clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = null;
  }

  function reportViewFailure(prefix: string, error: unknown) {
    const message = `${prefix}: ${errorMessage(error)}`;
    host?.reportError(message);
    if (!disposedRef.current) setStatus(`${prefix}. Move the canvas or select it again to retry.`);
  }

  async function save(): Promise<boolean> {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const operation = saveCurrentDocument();
    saveInFlightRef.current = operation;
    try {
      return await operation;
    } finally {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
    }
  }

  async function saveCurrentDocument(): Promise<boolean> {
    clearAutosaveTimer();
    const repository = repositoryRef.current;
    const selected = currentRef.current;
    const scene = documentRef.current;
    const savingFingerprint = documentFingerprintRef.current;
    if (!host || !repository || !selected || !scene) return false;
    if (!savingFingerprint || savingFingerprint === savedFingerprintRef.current) {
      updateSaveState("clean");
      return true;
    }
    updateSaveState("saving");
    setStatus("Saving...");
    try {
      const result = await repository.replaceCanvas(selected, scene);
      if (result.outcome !== "applied" || !result.canvas) {
        if (currentRef.current?.id !== selected.id || currentRef.current.revision !== selected.revision) return false;
        updateSaveState("dirty");
        setExternalConflict(result.canvas);
        setStatus(result.outcome === "not-found" ? "Canvas was removed elsewhere." : "Canvas changed elsewhere; save was not applied.");
        return false;
      }
      replaceMeta(result.canvas);
      if (currentRef.current?.id !== selected.id || currentRef.current.revision !== selected.revision) return true;
      currentRef.current = result.canvas;
      setCurrent(result.canvas);
      savedFingerprintRef.current = savingFingerprint;
      if (documentFingerprintRef.current === savingFingerprint) {
        updateSaveState("clean");
        setStatus(`Saved ${formatTimestamp(result.canvas.updated_at)} (${formatBytes(result.canvas.byte_length ?? 0)}).`);
      } else {
        updateSaveState("dirty");
        setStatus("Saved, with newer changes pending autosave.");
        scheduleAutosave();
      }
      return true;
    } catch (error) {
      if (currentRef.current?.id !== selected.id || currentRef.current.revision !== selected.revision) {
        host.reportError(`Save failed for ${selected.title}: ${errorMessage(error)}`);
        return false;
      }
      clearAutosaveTimer();
      updateSaveState("dirty");
      reportFailure("Save failed", error);
      return false;
    }
  }

  async function flushChanges(): Promise<boolean> {
    clearAutosaveTimer();
    for (;;) {
      const inFlight = saveInFlightRef.current;
      if (inFlight && !(await inFlight)) return false;
      if (documentFingerprintRef.current === savedFingerprintRef.current) return true;
      if (!(await save())) return false;
      clearAutosaveTimer();
    }
  }

  function runAfterAutosave(action: () => Promise<unknown>) {
    if (actionBusyRef.current || conflictRecoveryRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    void (async () => {
      try {
        if (await flushChanges()) await action();
      } catch (error) {
        reportFailure("Whiteboard action failed", error);
      } finally {
        actionBusyRef.current = false;
        if (!disposedRef.current) setActionBusy(false);
      }
    })();
  }

  function scheduleAutosave() {
    if (!host) return;
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void save();
    }, AUTOSAVE_DELAY_MS);
  }

  function clearAutosaveTimer() {
    if (autosaveTimerRef.current === null) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }

  function updateSaveState(next: SaveState) {
    saveStateRef.current = next;
    setSaveState(next);
  }

  function readSaveState(): SaveState {
    return saveStateRef.current;
  }

  async function createCanvas(title: string) {
    const result = await requireRepository().createCanvas(title);
    setCanvases((items) => [...items, result.canvas]);
    await openCanvas(result.canvas.id);
  }

  async function manageCanvas(canvas: CanvasMeta, action: "rename" | "duplicate" | "trash" | "restore", title?: string) {
    const result = await requireRepository().manageCanvas(canvas, action, title);
    if ("outcome" in result && result.outcome === "not-found") throw new Error("Canvas no longer exists.");
    if (!("outcome" in result)) {
      setCanvases((items) => [...items, result.canvas]);
      await openCanvas(result.canvas.id);
      return;
    }
    if (result.outcome !== "applied" || !result.canvas) {
      if (result.canvas) replaceMeta(result.canvas);
      throw new Error(`Canvas ${action} was not applied because it changed elsewhere.`);
    }
    replaceMeta(result.canvas);
    if (currentRef.current?.id === result.canvas.id) {
      currentRef.current = result.canvas;
      setCurrent(result.canvas);
    }
    if (action === "trash") {
      const fallback = canvasesRef.current.find((item) => item.id !== canvas.id && item.trashed_at === null);
      if (fallback) await openCanvas(fallback.id);
      else await createCanvas("Untitled canvas");
    }
    setStatus(`Canvas ${pastTense(action)}.`);
  }

  async function purgeCanvas(canvas: CanvasMeta) {
    const result = await requireRepository().purgeCanvas(canvas);
    if (result.outcome === "purged") {
      setCanvases((items) => items.filter((item) => item.id !== canvas.id));
      setStatus("Canvas permanently deleted.");
    } else {
      if (result.canvas) replaceMeta(result.canvas);
      throw new Error("Canvas was not deleted because its state changed elsewhere.");
    }
  }

  async function keepConflictAsCopy() {
    if (conflictRecoveryRef.current) return;
    const selected = currentRef.current;
    const scene = documentRef.current;
    const sceneFingerprint = documentFingerprintRef.current;
    if (!selected || !scene) return;
    conflictRecoveryRef.current = true;
    setConflictRecoveryBusy(true);
    try {
      // Stage the actual work in the create itself; never leave an empty recovery copy.
      const created = await requireRepository().createCanvas(deriveCopyTitle(selected.title, true), scene);
      setCanvases((items) => [...items.filter((item) => item.id !== created.canvas.id), created.canvas]);
      if (currentRef.current?.id !== selected.id || documentFingerprintRef.current !== sceneFingerprint) {
        setStatus("Conflict copy saved. Newer edits remain on the current canvas.");
        return;
      }
      await openCanvas(created.canvas.id);
    } catch (error) {
      reportFailure("Could not create a conflict copy", error);
    } finally {
      conflictRecoveryRef.current = false;
      setConflictRecoveryBusy(false);
    }
  }

  async function discardConflictAndReload(canvas: CanvasMeta) {
    if (conflictRecoveryRef.current) return;
    conflictRecoveryRef.current = true;
    setConflictRecoveryBusy(true);
    try {
      await openCanvas(canvas.id);
    } catch (error) {
      reportFailure("Could not reload the external canvas", error);
    } finally {
      conflictRecoveryRef.current = false;
      setConflictRecoveryBusy(false);
    }
  }

  async function reviewProposal(proposal: CanvasProposal, decision: "apply" | "reject") {
    if (proposalBusy) return;
    setProposalBusy(proposal.artifactId);
    proposalRefreshGenerationRef.current += 1;
    try {
      const target = await requireRepository().getCanvasMeta(proposal.targetId);
      if (!target) throw new Error("The proposal target no longer exists.");
      const result = decision === "apply"
        ? await requireRepository().applyProposal(target, proposal)
        : await requireRepository().rejectProposal(target, proposal);
      if (result.outcome === "applied") {
        replaceMeta(result.canvas!);
        proposalRefreshGenerationRef.current += 1;
        setPendingProposals((items) => items.filter((item) => item.artifactId !== proposal.artifactId));
        if (currentRef.current?.id === target.id) {
          if (decision === "apply" || currentRef.current.revision !== target.revision) {
            await openCanvas(target.id);
          } else {
            currentRef.current = result.canvas;
            setCurrent(result.canvas);
          }
        }
        setStatus(decision === "apply" ? "Proposal applied." : "Proposal rejected.");
      } else if (result.outcome === "replayed") {
        setPendingProposals((items) => items.filter((item) => item.artifactId !== proposal.artifactId));
        setStatus("Proposal was already recorded and was not replayed.");
      } else if (result.outcome === "stale" || result.outcome === "conflict") {
        setStatus("Proposal is stale. Reload the canvas before deciding whether to keep the change.");
      } else {
        throw new Error("Proposal target was not found.");
      }
    } catch (error) {
      reportFailure(`Could not ${decision} proposal`, error);
    } finally {
      setProposalBusy(null);
    }
  }

  function replaceMeta(canvas: CanvasMeta) {
    setCanvases((items) => {
      const existing = items.find((item) => item.id === canvas.id);
      return existing && existing.revision > canvas.revision
        ? items
        : [...items.filter((item) => item.id !== canvas.id), canvas];
    });
  }

  function reportFailure(prefix: string, error: unknown) {
    const message = `${prefix}: ${errorMessage(error)}`;
    setStatus(message);
    host?.reportError(message);
  }

  const activeCanvases = canvases.filter((canvas) => canvas.trashed_at === null);
  const trashedCanvases = canvases.filter((canvas) => canvas.trashed_at !== null);
  const visibleCanvases = showTrash ? trashedCanvases : activeCanvases;

  if (!loadedScene || !current) {
    return <CenteredMessage title="Opening whiteboard" detail={status} />;
  }

  return (
    <main className="whiteboard-shell">
      <header className="app-bar">
        <button className="menu-button" type="button" onClick={() => setNavigatorOpen((open) => !open)} aria-label="Toggle canvas list" aria-expanded={navigatorOpen}>Menu</button>
        <div className="identity">
          <span className="eyebrow">Whiteboard</span>
          <strong title={current.title}>{current.title}</strong>
        </div>
        <p className="status" role="status" aria-live="polite">
          <span className={`status-dot status-dot--${saveState}`} aria-hidden="true" />
          {status}
        </p>
      </header>

      <aside className={`navigator${navigatorOpen ? " navigator--open" : ""}`} aria-label="Canvases">
        <div className="navigator-heading">
          <strong>Canvases</strong>
          <button type="button" className="new-button" onClick={() => runAfterAutosave(async () => setDialog({ kind: "title", mode: "create", canvas: null, value: "" }))}>New</button>
        </div>
        <div className="view-tabs" role="group" aria-label="Canvas collection">
          <button type="button" className={!showTrash ? "active" : ""} onClick={() => setShowTrash(false)}>Active <span>{activeCanvases.length}</span></button>
          <button type="button" className={showTrash ? "active" : ""} onClick={() => setShowTrash(true)}>Trash <span>{trashedCanvases.length}</span></button>
        </div>
        <div className="canvas-list">
          {visibleCanvases.length === 0 ? <p className="empty-list">{showTrash ? "Trash is empty." : "No canvases yet."}</p> : null}
          {visibleCanvases.map((canvas) => (
            <article className={`canvas-list-item${current.id === canvas.id ? " selected" : ""}`} key={canvas.id}>
              {!showTrash ? (
                <button className="canvas-link" type="button" onClick={() => runAfterAutosave(() => openCanvas(canvas.id))}>
                  <span>{canvas.title}</span>
                  <small>{canvas.summary.element_count} elements / r{canvas.revision}</small>
                </button>
              ) : (
                <div className="canvas-link canvas-link--static">
                  <span>{canvas.title}</span>
                  <small>Deleted {formatTimestamp(canvas.trashed_at!)}</small>
                </div>
              )}
              <div className="item-actions">
                {!showTrash ? (
                  <>
                    <button type="button" onClick={() => runAfterAutosave(async () => {
                      const latest = currentRef.current?.id === canvas.id ? currentRef.current : canvas;
                      setDialog({ kind: "title", mode: "rename", canvas: latest, value: latest.title });
                    })}>Rename</button>
                    <button type="button" onClick={() => runAfterAutosave(() => manageCanvas(currentRef.current?.id === canvas.id ? currentRef.current : canvas, "duplicate"))}>Duplicate</button>
                    <button type="button" onClick={() => runAfterAutosave(async () => setDialog({ kind: "trash", canvas: currentRef.current?.id === canvas.id ? currentRef.current : canvas }))}>Trash</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => void manageCanvas(canvas, "restore").catch((error) => reportFailure("Could not restore canvas", error))}>Restore</button>
                    <button type="button" onClick={() => setDialog({ kind: "purge", canvas })}>Delete forever</button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      </aside>

      <section className="canvas" aria-label="Whiteboard editor">
        {pendingProposals.length > 0 ? (
          <section className="proposal-review" aria-label="Pending canvas proposals">
            {pendingProposals.map((proposal) => (
              <article className="proposal-card" key={proposal.artifactId}>
                <div><strong>Review canvas proposal</strong><span>{canvases.find((canvas) => canvas.id === proposal.targetId)?.title ?? "Unknown canvas"}</span><small>Expected revision {proposal.targetRevision} · {proposal.operations.length} semantic operation{proposal.operations.length === 1 ? "" : "s"}</small></div>
                <div className="proposal-actions"><button type="button" disabled={proposalBusy !== null || actionBusy || conflictRecoveryBusy} onClick={() => runAfterAutosave(() => reviewProposal(proposal, "apply"))}>Apply</button><button type="button" className="secondary" disabled={proposalBusy !== null || actionBusy || conflictRecoveryBusy} onClick={() => runAfterAutosave(() => reviewProposal(proposal, "reject"))}>Reject</button></div>
              </article>
            ))}
          </section>
        ) : null}
        {externalConflict !== undefined ? (
          <div className="conflict-banner" role="alert">
            <span>{externalConflict ? "This canvas changed elsewhere." : "This canvas was removed elsewhere."}</span>
            {externalConflict ? <button type="button" disabled={conflictRecoveryBusy} onClick={() => void discardConflictAndReload(externalConflict)}>Discard mine and reload</button> : null}
            <button type="button" disabled={conflictRecoveryBusy} onClick={() => void keepConflictAsCopy()}>{conflictRecoveryBusy ? "Working..." : "Keep mine as copy"}</button>
            <button type="button" disabled={conflictRecoveryBusy} onClick={() => setExternalConflict(undefined)}>Dismiss</button>
          </div>
        ) : null}
        <Excalidraw
          key={loadedScene.key}
          initialData={loadedScene.initialData}
          onChange={handleChange}
          onScrollChange={handleViewportChange}
          aiEnabled={false}
          validateEmbeddable={false}
          onLinkOpen={(_element, event) => {
            event.preventDefault();
            setStatus("External links are disabled inside the Kestral sandbox.");
          }}
          excalidrawAPI={() => {
            requestAnimationFrame(() => {
              editorInitializedRef.current = true;
            });
          }}
          viewModeEnabled={conflictRecoveryBusy || actionBusy || dialog !== null}
          theme={theme}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              saveAsImage: false,
              toggleTheme: false,
            },
          }}
        />
      </section>

      {navigatorOpen ? <button className="navigator-backdrop" type="button" aria-label="Close canvas list" onClick={() => setNavigatorOpen(false)} /> : null}
      {dialog ? <WorkspaceDialog state={dialog} setState={setDialog} onCreate={createCanvas} onRename={(canvas, title) => manageCanvas(canvas, "rename", title)} onTrash={(canvas) => manageCanvas(canvas, "trash")} onPurge={purgeCanvas} onError={(error) => reportFailure("Whiteboard action failed", error)} /> : null}
    </main>
  );
}

function WorkspaceDialog({
  state,
  setState,
  onCreate,
  onRename,
  onTrash,
  onPurge,
  onError,
}: {
  state: Exclude<DialogState, null>;
  setState: (state: DialogState) => void;
  onCreate: (title: string) => Promise<void>;
  onRename: (canvas: CanvasMeta, title: string) => Promise<void>;
  onTrash: (canvas: CanvasMeta) => Promise<void>;
  onPurge: (canvas: CanvasMeta) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [title, setTitle] = useState(state.kind === "title" ? state.value : "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setState(null);
    } catch (error) {
      setFailure(errorMessage(error));
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "title") {
    const trimmed = title.trim();
    const tooLong = new TextEncoder().encode(trimmed).byteLength > MAX_TITLE_BYTES;
    return (
      <Dialog title={state.mode === "create" ? "New canvas" : "Rename canvas"} detail="Canvas names can be changed later." failure={tooLong ? `Canvas names must be at most ${MAX_TITLE_BYTES} UTF-8 bytes.` : failure} closeDisabled={busy} onClose={() => setState(null)}>
        <label className="title-field">Name<input autoFocus value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
        <button type="button" disabled={busy || !trimmed || tooLong} onClick={() => void run(() => state.mode === "create" ? onCreate(trimmed) : onRename(state.canvas!, trimmed))}>{state.mode === "create" ? "Create canvas" : "Rename"}</button>
      </Dialog>
    );
  }

  if (state.kind === "trash") {
    return (
      <Dialog title="Move canvas to trash?" detail={`"${state.canvas.title}" can be restored later.`} failure={failure} closeDisabled={busy} onClose={() => setState(null)}>
        <button type="button" disabled={busy} onClick={() => void run(() => onTrash(state.canvas))}>Move to trash</button>
      </Dialog>
    );
  }

  return (
    <Dialog title="Delete forever?" detail={`"${state.canvas.title}" and its embedded files cannot be recovered.`} failure={failure} closeDisabled={busy} onClose={() => setState(null)}>
      <button type="button" className="danger" disabled={busy} onClick={() => void run(() => onPurge(state.canvas))}>Delete forever</button>
    </Dialog>
  );
}

function Dialog({ title, detail, failure, closeDisabled, onClose, children }: { title: string; detail: string; failure: string | null; closeDisabled: boolean; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    }
    return () => {
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!closeDisabled) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-detail" aria-busy={closeDisabled} onKeyDown={handleKeyDown}>
        <span className="eyebrow">Kestral Whiteboard</span>
        <h2 id="dialog-title">{title}</h2>
        <p id="dialog-detail">{detail}</p>
        {failure ? <p className="dialog-error" role="alert">{failure}</p> : null}
        <div className="dialog-actions">{children}<button type="button" className="secondary" disabled={closeDisabled} onClick={onClose}>Cancel</button></div>
      </section>
    </div>
  );
}

function CenteredMessage({ title, detail }: { title: string; detail: string }) {
  return <main className="centered-message"><div><span className="eyebrow">Kestral Whiteboard</span><h1>{title}</h1><p>{detail}</p></div></main>;
}

function previewCanvas(): CanvasMeta {
  return {
    format_version: 2,
    id: PREVIEW_ID,
    title: "Preview canvas",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    revision: 1,
    trashed_at: null,
    byte_length: 0,
    sha256: "0".repeat(64),
    summary: { element_count: 0, element_count_by_type: {}, deleted_count: 0, bounds: null, text_snippets: [] },
    metadata: { schema_version: 2, title: "Preview canvas", trashed_at: null, summary: { element_count: 0, element_count_by_type: {}, deleted_count: 0, bounds: null, text_snippets: [] }, searchable_text: "", applied_proposals: [] },
  };
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function pastTense(action: string): string {
  return action === "rename" ? "renamed" : action === "trash" ? "moved to trash" : action === "restore" ? "restored" : "duplicated";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function documentFingerprint(document: BoardDocument): string {
  return JSON.stringify(document);
}
