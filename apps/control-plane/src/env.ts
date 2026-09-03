export interface Env {
  PROJECT_ROOMS: DurableObjectNamespace<import("./project-room").ProjectRoom>;
  RENDER_CONTAINERS?: DurableObjectNamespace;
  MEDIA_WORKFLOW?: Workflow<{ projectId: string; jobId: string }>;
  RENDER_WORKFLOW?: Workflow<{ projectId: string; jobId: string }>;
  MEDIA?: R2Bucket;
  PRAXIS_OWNER_TOKEN: string;
  PRAXIS_CAPABILITY_SIGNING_SECRET: string;
  PRAXIS_AUTH_MODE?: "development_owner" | "cloudflare_access";
  PRAXIS_ACCESS_TEAM_DOMAIN?: string;
  PRAXIS_ACCESS_AUD?: string;
  PRAXIS_BROWSER_SESSION_SIGNING_SECRET?: string;
  PRAXIS_BROWSER_SESSION_TTL_SECONDS?: string;
  PRAXIS_AGENT_CLAIM_SIGNING_SECRET?: string;
  PRAXIS_AGENT_LEASE_SECONDS?: string;
  PRAXIS_DISPATCHER_TOKEN?: string;
  PRAXIS_RECONCILE_INTERVAL_SECONDS?: string;
  PRAXIS_CANCEL_GRACE_SECONDS?: string;
  PRAXIS_ALLOWED_ORIGIN?: string;
  PRAXIS_IMAGE_MODEL?: string;
  PRAXIS_TTS_MODEL?: string;
  PRAXIS_TTS_VOICE?: string;
  PRAXIS_PROVIDER_MODE?: "fake" | "openai";
  PRAXIS_FAKE_IMAGE_URL?: string;
  PRAXIS_RENDER_WORKER_URL?: string;
  PRAXIS_RENDER_WORKER_TOKEN?: string;
  PRAXIS_RENDER_AUTH_SECRET?: string;
  PRAXIS_RENDER_RESULT_SIGNING_SECRET?: string;
  PRAXIS_RENDER_RESULT_SIGNING_KEY_ID?: string;
  PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON?: string;
  PRAXIS_API_BASE_URL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  OPENAI_API_KEY?: string;
}

export interface AuthenticatedActor {
  kind: "director" | "codex" | "system";
  id: string;
  runId?: string;
  capabilityMaxSpendUsd?: number;
  deniedEntityIds: string[];
  scopes: string[];
  owner: boolean;
  authentication: "owner_token" | "cloudflare_access" | "capability";
}
