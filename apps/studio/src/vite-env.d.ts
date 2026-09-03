/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "false" only for a fully configured Studio with media and cloud-run actions. */
  readonly VITE_PRAXIS_SUBMISSION_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ModelContextRegistration {
  unregister?: () => void;
}

interface ModelContext {
  registerTool?: (
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      execute: (input: unknown, context?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<ModelContextRegistration | void> | ModelContextRegistration | void;
}

interface Document {
  modelContext?: ModelContext;
}
