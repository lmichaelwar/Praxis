import type { AgentRunRole, AgentRunStatus } from "@praxis/agent-runs";

export type StudioActor = "director" | "codex" | "system";
export type AuthorityMode = "observe" | "propose" | "act" | "locked";
export type StudioStageName =
  | "treatment"
  | "script"
  | "previz"
  | "assets"
  | "edit"
  | "finish";

export interface StageView {
  id: StudioStageName;
  label: string;
  mode: AuthorityMode;
  status: "draft" | "working" | "approved" | "stale";
}

export interface SceneView {
  id: string;
  beatId: string;
  index: number;
  title: string;
  narration: string;
  visualIntent: string;
  shotLabel: string;
  startFrame: number;
  durationFrames: number;
  status: "draft" | "approved" | "stale" | "failed" | "proposed";
  locked: boolean;
  authoredBy: StudioActor;
  thumbnailPosition: string;
}

export interface TimelineClipView {
  id: string;
  sceneId?: string;
  label: string;
  trackId: string;
  startFrame: number;
  durationFrames: number;
  kind: "video" | "title" | "audio" | "proposal";
  status?: "draft" | "approved" | "stale" | "failed" | "proposed";
  locked?: boolean;
}

export interface TrackView {
  id: string;
  label: string;
  role: string;
  clips: TimelineClipView[];
}

export interface LedgerView {
  id: string;
  revision: number;
  actor: StudioActor;
  action: string;
  detail: string;
  timestamp: string;
  tone?: "normal" | "warning" | "success";
  checkpointId?: string;
}

export interface SelectionView {
  sceneId: string | null;
  clipId: string | null;
  playheadFrame: number;
  activeView: "script" | "scenes";
}

export interface DelegationDraft {
  modes: Record<StudioStageName, AuthorityMode>;
  maxSpendUsd: number;
  preserveLocked: boolean;
}

export interface CloudRunView {
  id: string;
  label: string;
  status: "idle" | AgentRunStatus;
  role?: AgentRunRole;
  baseRevision: number;
  maxSpendUsd: number;
  claimExpiresAt?: string;
  leaseExpiresAt?: string;
  codexTaskUrl?: string;
  completionSummary?: string;
  errorMessage?: string;
}

export interface BackendConnectionView {
  status: "loading" | "connected" | "reconnecting" | "conflict" | "error";
  message: string;
}

export interface JobQueueView {
  id: string;
  type: "image.generate" | "speech.generate" | "render.preview" | "render.final";
  status: "queued" | "running" | "waiting_external" | "succeeded" | "failed" | "cancel_requested" | "cancelled";
  baseRevision: number;
  reservedCostUsd: number;
  settledCostUsd: number;
  error?: string;
  stale?: boolean;
  attached?: boolean;
  cancellable: boolean;
}

export interface AssetVersionView {
  id: string;
  label: string;
  status: "planned" | "generating" | "ready" | "approved" | "rejected" | "stale" | "failed";
  selected: boolean;
  unattached: boolean;
  accessUrl?: string;
}

export const STAGE_ORDER: StudioStageName[] = [
  "treatment",
  "script",
  "previz",
  "assets",
  "edit",
  "finish",
];

export function formatFrames(frames: number, fps = 30): string {
  const safeFrames = Math.max(0, Math.floor(frames));
  const totalSeconds = Math.floor(safeFrames / fps);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const remainder = safeFrames % fps;

  return [hours, minutes, seconds, remainder]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatDuration(frames: number, fps = 30): string {
  const totalSeconds = Math.round(frames / fps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
