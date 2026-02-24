export type SyncSchemaWorkspaceExtensionPersistence = "runtime_only" | "persisted_requires_schema";

export type SyncSchemaWorkspaceExtension = {
  /**
   * runtime_only:
   *   Allowed in workspace sync guards but must not be persisted in openclaw.json.
   * persisted_requires_schema:
   *   If persisted, this key must exist in the core schema/types.
   */
  persistence: SyncSchemaWorkspaceExtensionPersistence;
  /** Optional placeholder used by sync-schema guard tests. */
  placeholder?: unknown;
};

export const SYNC_SCHEMA_WORKSPACE_EXTENSIONS: Record<string, SyncSchemaWorkspaceExtension> = {
  // Derived at sync/runtime from DGX reachability policy, not persisted in config.
  "dgx.resolvedAccessMode": {
    persistence: "runtime_only",
    placeholder: "wan",
  },
};
