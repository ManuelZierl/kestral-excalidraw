export interface CapabilityRef { provider: string; capability: string; }
export interface SurfaceArtifact { artifact_id: string; artifact_type: string; title: string; content: unknown; }
export interface SurfaceStateEntry { revision: number; value: Record<string, unknown> | null; }
export interface AppHostBridge {
  ready(): void;
  reportError(message: string): void;
  onInit(callback: (context: {
    theme: "light" | "dark" | null;
    variables: Record<string, string>;
  }) => void): void;
  onEvent(callback: () => void): void;
  invoke(capability: CapabilityRef, input: Record<string, unknown>, goal?: string): Promise<unknown>;
  invokeScoped(capability: CapabilityRef, input: Record<string, unknown>, dataScope: { kind: "none" | "all-resources" | "resources"; resource_ids?: string[] }, goal?: string): Promise<unknown>;
  listArtifacts(): Promise<SurfaceArtifact[]>;
  getState(key: string): Promise<SurfaceStateEntry>;
  putState(key: string, expectedRevision: number, value: Record<string, unknown> | null): Promise<SurfaceStateEntry>;
  theme: "light" | "dark" | null;
  variables: Record<string, string>;
}

declare global {
  interface Window {
    appHost?: AppHostBridge;
  }
}
