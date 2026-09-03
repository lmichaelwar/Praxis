import type { AuthenticatedActor } from "./env";

export const actorEnvelope = (actor: AuthenticatedActor) => ({
  kind: actor.kind,
  sessionId: actor.id.replace(/[^A-Za-z0-9:_-]/gu, "_").slice(0, 120) || "remote_actor",
});

const requestsCodexDowngrade = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false;
  const requested = (body as { actor?: unknown }).actor;
  return Boolean(requested && typeof requested === "object" && (requested as { kind?: unknown }).kind === "codex");
};

/** An authenticated director may voluntarily attribute a mutation to the WebMCP agent. */
export const commandActorEnvelope = (body: unknown, actor: AuthenticatedActor) => {
  if (actor.owner && actor.kind === "director" && requestsCodexDowngrade(body)) {
    return { kind: "codex" as const, sessionId: "session_webmcp" };
  }
  return actorEnvelope(actor);
};

export const normalizeCommand = (body: unknown, projectId: string, actor: AuthenticatedActor) => {
  if (!body || typeof body !== "object") return body;
  return {
    ...(body as Record<string, unknown>),
    projectId,
    actor: commandActorEnvelope(body, actor),
    createdAt: (body as Record<string, unknown>).createdAt ?? new Date().toISOString(),
  };
};
