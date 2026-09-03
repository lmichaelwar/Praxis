import { createSeedProject, StableIdSchema } from "@praxis/project-schema";
import { JobCreateRequestSchema } from "@praxis/jobs";
import {
  AgentRunClaimRequestSchema,
  AgentRunStatusSchema,
  CreateAgentRunInputSchema,
  type AgentRun,
} from "@praxis/agent-runs";
import { z } from "zod";
import { authenticate, deniedCommandEntities, mintCapability, PraxisCapabilitySchema, type CapabilityScope } from "./capabilities";
import type { AuthenticatedActor, Env } from "./env";
import { ProjectRoom, type ProjectRoomClient, type RoomResult } from "./project-room";
import { bootstrapSeedMedia } from "./bootstrap";
import { hasR2PresigningConfiguration, presignR2Object } from "./r2-presign";
import { handleLocalRenderInput, handleLocalRenderUpload } from "./render-upload";
import { requestRenderCancellation } from "./workflow";
import {
  DirectUploadFinalizeSchema,
  DirectUploadRequestSchema,
  directUploadCommandOperations,
  directUploadObjectKey,
  persistedUploadRecord,
  sameImmutableUploadRecord,
  verifyDirectUploadObject,
} from "./direct-upload";
import { accessMutationOriginAllowed, verifyAccessIdentity } from "./access-auth";
import { browserSessionCookie, expiredBrowserSessionCookie, mintBrowserSession } from "./browser-session";
import { workflowInstanceId } from "./workflow-instance";
import { claimTicketDigest, verifyAgentClaimTicket } from "./agent-claim-ticket";
import { actorEnvelope, commandActorEnvelope, normalizeCommand } from "./actor";
import { requireMediaBinding } from "./media-binding";
export { ProjectRoom } from "./project-room";
export { RenderContainer } from "./render-container";
export { MediaWorkflow, RenderWorkflow } from "./workflow";

const MAX_JSON_BYTES = 1_000_000;
const ProjectIdSchema = StableIdSchema;
const RevisionActionSchema = z
  .object({
    commandId: StableIdSchema.optional(),
    idempotencyKey: z.string().min(8).max(128),
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();
const CheckpointCreateSchema = RevisionActionSchema.extend({
  checkpointId: StableIdSchema.optional(),
  label: z.string().min(1).max(160),
  reason: z.string().max(1_000).optional(),
  actor: z.object({ kind: z.literal("codex") }).strict().optional(),
}).strict();
const RestoreSchema = RevisionActionSchema.extend({ reason: z.string().max(1_000).optional() }).strict();
const AgentRunCancelSchema = z.object({ idempotencyKey: z.string().min(8).max(160) }).strict();
const DispatchLeaseSchema = z.object({
  projectId: StableIdSchema,
  dispatcherId: StableIdSchema,
  leaseSeconds: z.number().int().min(60).max(1_800).default(600),
}).strict();
const DispatchResultSchema = z.object({
  projectId: StableIdSchema,
  dispatchAttemptId: StableIdSchema,
  idempotencyKey: z.string().min(8).max(160),
  action: z.enum(["record_task", "mark_unknown", "mark_failed"]),
  codexTaskId: z.string().min(1).max(256).optional(),
  codexTaskUrl: z.string().url().max(2_048).optional(),
  errorCode: z.string().min(1).max(160).optional(),
  errorMessage: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "record_task" && !value.codexTaskId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["codexTaskId"], message: "record_task requires codexTaskId" });
  }
  if (value.action === "mark_failed" && (!value.errorCode || !value.errorMessage)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorCode"], message: "mark_failed requires errorCode and errorMessage" });
  }
});
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...extraHeaders } });

const roomResponse = <T>(result: RoomResult<T>, successStatus = 200): Response =>
  result.ok ? json(result.value, successStatus) : json(result.error, result.status);

const readJson = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new Error("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new Error("REQUEST_TOO_LARGE");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const jobActor = (actor: AuthenticatedActor) => ({
  kind: actor.kind,
  id: actor.id,
  runId: actor.runId,
  capabilityMaxSpendUsd: actor.capabilityMaxSpendUsd,
});

const roomFor = (env: Env, projectId: string) => env.PROJECT_ROOMS.getByName(projectId) as unknown as ProjectRoomClient;

const stableRequestId = async (prefix: string, value: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `${prefix}_${[...digest].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const authFailure = (result: Awaited<ReturnType<typeof authenticate>>) =>
  result.ok ? undefined : json({ code: result.code, message: result.message }, result.status);

const constantTimeTextEqual = async (left: string, right: string): Promise<boolean> => {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) difference |= leftBytes[index]! ^ rightBytes[index]!;
  return difference === 0;
};

const authorizeDispatcher = async (request: Request, env: Env): Promise<Response | undefined> => {
  const configured = env.PRAXIS_DISPATCHER_TOKEN;
  const header = request.headers.get("authorization");
  if (!configured || configured.length < 32) {
    return json({ code: "DISPATCHER_AUTH_NOT_CONFIGURED", message: "Dispatcher authentication is not configured" }, 503);
  }
  if (!header?.startsWith("Bearer ") || !(await constantTimeTextEqual(header.slice(7), configured))) {
    return json({ code: "DISPATCHER_AUTH_INVALID", message: "Dispatcher authentication failed" }, 401);
  }
  return undefined;
};

const agentActorOwnsRun = (actor: AuthenticatedActor, runId: string) => actor.owner || actor.runId === runId;

const mintAgentRunCapability = async (run: AgentRun, env: Env) => {
  if (!run.leaseExpiresAt) throw new Error("Claimed AgentRun has no lease");
  const capabilityToken = await mintCapability({
    subject: `agent:${run.id}`,
    projectId: run.projectId,
    runId: run.id,
    scopes: run.scopes,
    maxSpendUsd: run.maxSpendUsd,
    deniedEntityIds: run.deniedEntityIds,
    expiresAt: run.leaseExpiresAt,
  }, env.PRAXIS_CAPABILITY_SIGNING_SECRET);
  return { capabilityToken, expiresAt: run.leaseExpiresAt };
};

const authorize = async (request: Request, env: Env, projectId: string | undefined, scope?: CapabilityScope, ownerOnly = false) => {
  const result = await authenticate(request, env, { projectId, scope, ownerOnly });
  return result;
};

const startWorkflow = async (env: Env, projectId: string, jobId: string, jobType: string) => {
  const binding = jobType.startsWith("render.") ? env.RENDER_WORKFLOW : env.MEDIA_WORKFLOW;
  if (!binding) return undefined;
  const instanceId = await workflowInstanceId(projectId, jobId, jobType);

  // Persist the deterministic identity before making the external create call.
  // If the create response is lost after Cloudflare accepted it, the alarm can
  // still reconcile the same instance instead of treating the job as orphaned.
  const attached = await roomFor(env, projectId).attachWorkflow(jobId, instanceId);
  if (!attached.ok) throw new Error(`${attached.error.code}: ${attached.error.message}`);

  let instance;
  try {
    // Cloudflare's binding throws when the instance ID does not exist.
    instance = await binding.get(instanceId);
  } catch {
    try {
      instance = await binding.create({ id: instanceId, params: { projectId, jobId } });
    } catch {
      // Concurrent/idempotent retries may observe the persisted job before its
      // first request attaches the already-created Workflow handle.
      try {
        instance = await binding.get(instanceId);
      } catch {
        // Creation is an externally visible operation whose response can be
        // ambiguous. Keep the durable deterministic ID attached and let the
        // reconciliation alarm retry get/create rather than falsely failing a
        // Workflow that may already be running.
        return instanceId;
      }
    }
  }
  if (instance.id !== instanceId) throw new Error("Workflow binding returned a non-deterministic instance identity");
  return instanceId;
};

const withCors = (response: Response, request: Request, env: Env) => {
  const origin = request.headers.get("origin");
  const allowed = env.PRAXIS_ALLOWED_ORIGIN;
  if (origin && allowed && origin === allowed) {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
    headers.set("access-control-allow-credentials", "true");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
};

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    if (!origin || !env.PRAXIS_ALLOWED_ORIGIN || origin !== env.PRAXIS_ALLOWED_ORIGIN) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,last-event-id,x-praxis-sha256,x-praxis-mime-type",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok", service: "praxis-control-plane", storageSchemaVersion: 3 });
  }

  if (request.method === "POST" && url.pathname === "/auth/session") {
    if (
      env.PRAXIS_AUTH_MODE !== "cloudflare_access" ||
      !env.PRAXIS_ACCESS_TEAM_DOMAIN ||
      !env.PRAXIS_ACCESS_AUD ||
      !env.PRAXIS_BROWSER_SESSION_SIGNING_SECRET
    ) {
      return json({ code: "SESSION_EXCHANGE_DISABLED", message: "Browser session exchange is not configured" }, 404);
    }
    if (!accessMutationOriginAllowed(request, env.PRAXIS_ALLOWED_ORIGIN)) {
      return json({ code: "SESSION_ORIGIN_DENIED", message: "Browser session exchange requires the trusted Studio origin" }, 403);
    }
    try {
      const identity = await verifyAccessIdentity(request, {
        teamDomain: env.PRAXIS_ACCESS_TEAM_DOMAIN,
        audience: env.PRAXIS_ACCESS_AUD,
      });
      const configuredTtl = Number(env.PRAXIS_BROWSER_SESSION_TTL_SECONDS ?? 28_800);
      const ttlSeconds = Number.isSafeInteger(configuredTtl)
        ? Math.min(43_200, Math.max(300, configuredTtl))
        : 28_800;
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1_000);
      const token = await mintBrowserSession({
        version: 1,
        subject: identity.id,
        email: identity.email,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }, env.PRAXIS_BROWSER_SESSION_SIGNING_SECRET);
      return json(
        { ok: true, expiresAt: expiresAt.toISOString() },
        201,
        { "set-cookie": browserSessionCookie(token, ttlSeconds) },
      );
    } catch {
      return json({ code: "ACCESS_SESSION_INVALID", message: "Cloudflare Access application session is invalid" }, 401);
    }
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    if (!accessMutationOriginAllowed(request, env.PRAXIS_ALLOWED_ORIGIN)) {
      return json({ code: "SESSION_ORIGIN_DENIED", message: "Browser session logout requires the trusted Studio origin" }, 403);
    }
    return json({ ok: true }, 200, { "set-cookie": expiredBrowserSessionCookie() });
  }

  if (url.pathname === "/internal/render-outputs") {
    return handleLocalRenderUpload(request, env);
  }
  if (url.pathname === "/internal/render-inputs") {
    return handleLocalRenderInput(request, env);
  }

  if (segments[0] === "internal" && segments[1] === "agent-dispatch") {
    const authError = await authorizeDispatcher(request, env);
    if (authError) return authError;
    if (request.method === "POST" && segments[2] === "lease" && segments.length === 3) {
      const parsed = DispatchLeaseSchema.safeParse(await readJson(request));
      if (!parsed.success) return json({ code: "INVALID_DISPATCH_LEASE", message: parsed.error.message }, 400);
      const result = await roomFor(env, parsed.data.projectId).leaseNextAgentRun(parsed.data.dispatcherId, parsed.data.leaseSeconds);
      if (!result.ok) return roomResponse(result);
      return result.value ? json(result.value, 201) : new Response(null, { status: 204 });
    }
    if (request.method === "GET" && segments[2] === "runs" && segments.length === 3) {
      const projectId = StableIdSchema.safeParse(url.searchParams.get("projectId"));
      const statuses = (url.searchParams.get("statuses") ?? "dispatching,dispatch_unknown").split(",").filter(Boolean);
      const parsedStatuses = z.array(AgentRunStatusSchema).min(1).safeParse(statuses);
      if (!projectId.success || !parsedStatuses.success) return json({ code: "INVALID_DISPATCH_QUERY", message: "A valid projectId and statuses list are required" }, 400);
      const result = await roomFor(env, projectId.data).listDispatchAgentRuns(parsedStatuses.data);
      return result.ok ? json({ runs: result.value }) : roomResponse(result);
    }
    if (request.method === "POST" && segments[2] === "runs" && segments[4] === "result" && segments.length === 5) {
      const runId = StableIdSchema.safeParse(segments[3]);
      const parsed = DispatchResultSchema.safeParse(await readJson(request));
      if (!runId.success) return json({ code: "INVALID_DISPATCH_RESULT", message: "AgentRun ID is invalid" }, 400);
      if (!parsed.success) return json({ code: "INVALID_DISPATCH_RESULT", message: parsed.error.message }, 400);
      const { projectId, dispatchAttemptId, ...input } = parsed.data;
      return roomResponse(await roomFor(env, projectId).recordAgentDispatchResult(runId.data, dispatchAttemptId, input));
    }
    return json({ code: "NOT_FOUND", message: "Dispatcher route does not exist" }, 404);
  }

  if (segments[0] !== "api") return json({ code: "NOT_FOUND", message: "Route does not exist" }, 404);

  if (request.method === "POST" && segments[1] === "agent-runs" && segments[2] === "claim" && segments.length === 3) {
    if (!env.PRAXIS_AGENT_CLAIM_SIGNING_SECRET) {
      return json({ code: "AGENT_CLAIM_NOT_CONFIGURED", message: "AgentRun claim signing is not configured" }, 503);
    }
    if (!env.PRAXIS_CAPABILITY_SIGNING_SECRET || env.PRAXIS_CAPABILITY_SIGNING_SECRET.length < 32) {
      return json({ code: "CAPABILITY_SIGNING_NOT_CONFIGURED", message: "AgentRun capability signing is not configured" }, 503);
    }
    const parsed = AgentRunClaimRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_AGENT_CLAIM", message: parsed.error.message }, 400);
    let claims;
    try {
      claims = await verifyAgentClaimTicket(parsed.data.ticket, env.PRAXIS_AGENT_CLAIM_SIGNING_SECRET);
    } catch {
      return json({ code: "AGENT_CLAIM_INVALID", message: "AgentRun claim ticket is invalid or expired" }, 401);
    }
    const claimed = await roomFor(env, claims.projectId).claimAgentRun(claims, await claimTicketDigest(parsed.data.ticket));
    if (!claimed.ok) return roomResponse(claimed);
    if (!claimed.value.run.leaseExpiresAt) return json({ code: "AGENT_CLAIM_INVALID", message: "Claimed AgentRun has no lease" }, 409);
    const grant = await mintAgentRunCapability(claimed.value.run, env);
    return json({ run: claimed.value.run, ...grant }, 201);
  }

  if (request.method === "POST" && segments[1] === "capabilities" && segments.length === 2) {
    const auth = await authorize(request, env, undefined, undefined, true);
    const failure = authFailure(auth);
    if (failure) return failure;
    const parsed = PraxisCapabilitySchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_CAPABILITY", message: parsed.error.message }, 400);
    return json({ token: await mintCapability(parsed.data, env.PRAXIS_CAPABILITY_SIGNING_SECRET), capability: parsed.data }, 201);
  }

  if (request.method === "POST" && segments[1] === "projects" && segments.length === 2) {
    const auth = await authorize(request, env, undefined, undefined, true);
    const failure = authFailure(auth);
    if (failure) return failure;
    const body = (await readJson(request)) as { projectId?: unknown; snapshot?: unknown };
    const snapshot = body?.snapshot ?? createSeedProject();
    const projectId = ProjectIdSchema.safeParse(body?.projectId ?? (snapshot as { projectId?: unknown }).projectId);
    if (!projectId.success) return json({ code: "INVALID_PROJECT_ID", message: projectId.error.message }, 400);
    if ((snapshot as { projectId?: unknown }).projectId !== projectId.data) return json({ code: "PROJECT_ID_MISMATCH", message: "Snapshot project ID must match the requested project ID" }, 400);
    const room = roomFor(env, projectId.data);
    const initialized = await room.initialize(snapshot);
    if (!initialized.ok) return roomResponse(initialized);
    await bootstrapSeedMedia(env, room, initialized.value.project);
    return roomResponse(await room.getHydration(), 201);
  }

  if (segments[1] !== "projects" || segments.length < 3) return json({ code: "NOT_FOUND", message: "Route does not exist" }, 404);
  const parsedProjectId = ProjectIdSchema.safeParse(segments[2]);
  if (!parsedProjectId.success) return json({ code: "INVALID_PROJECT_ID", message: "Project ID is invalid" }, 400);
  const projectId = parsedProjectId.data;
  const room = roomFor(env, projectId);

  if (request.method === "GET" && segments.length === 3) {
    const auth = await authorize(request, env, projectId, "project:read");
    const failure = authFailure(auth);
    if (failure) return failure;
    return roomResponse(await room.getHydration());
  }

  if (segments[3] === "agent-runs") {
    if (request.method === "POST" && segments.length === 4) {
      const auth = await authorize(request, env, projectId, "agent:dispatch", true);
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      const parsed = CreateAgentRunInputSchema.safeParse(await readJson(request));
      if (!parsed.success) return json({ code: "INVALID_AGENT_RUN", message: parsed.error.message }, 400);
      const runId = parsed.data.runId ?? await stableRequestId("run", `${projectId}:${parsed.data.idempotencyKey}`);
      const checkpointId = parsed.data.checkpointId ?? await stableRequestId("checkpoint_agent", `${projectId}:${parsed.data.idempotencyKey}`);
      const checkpointCommandId = parsed.data.checkpointCommandId ?? await stableRequestId("command_agent_checkpoint", `${projectId}:${parsed.data.idempotencyKey}`);
      const checkpointIdempotencyKey = await stableRequestId("idem_agent_checkpoint", `${projectId}:${parsed.data.idempotencyKey}`);
      const checkpoint = await room.createCheckpoint({
        checkpointId,
        commandId: checkpointCommandId,
        idempotencyKey: checkpointIdempotencyKey,
        baseRevision: parsed.data.baseRevision,
        label: parsed.data.checkpointLabel,
        reason: parsed.data.checkpointReason,
        actor: actorEnvelope(auth.actor),
        deniedEntityIds: [],
      });
      if (!checkpoint.ok) return roomResponse(checkpoint);
      return roomResponse(await room.createAgentRun({
        ...parsed.data,
        runId,
        checkpointId,
        checkpointCommandId,
        baseRevision: checkpoint.value.revision,
      }, actorEnvelope(auth.actor)), 201);
    }
    if (request.method === "GET" && segments.length === 4) {
      const auth = await authorize(request, env, projectId, "agent:read");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      const result = await room.listAgentRuns();
      if (!result.ok) return roomResponse(result);
      return json({ runs: auth.actor.owner ? result.value : result.value.filter((run) => run.id === auth.actor.runId) });
    }
    const runId = StableIdSchema.safeParse(segments[4]);
    if (!runId.success) return json({ code: "INVALID_AGENT_RUN_ID", message: "AgentRun ID is invalid" }, 400);
    if (request.method === "GET" && segments.length === 5) {
      const auth = await authorize(request, env, projectId, "agent:read");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (!agentActorOwnsRun(auth.actor, runId.data)) return json({ code: "AGENT_RUN_DENIED", message: "Capability does not belong to this AgentRun" }, 403);
      const result = await room.getAgentRun(runId.data);
      return result.ok ? json({ run: result.value }) : roomResponse(result);
    }
    if (request.method === "GET" && segments[5] === "context" && segments.length === 6) {
      const auth = await authorize(request, env, projectId, "project:read");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (!agentActorOwnsRun(auth.actor, runId.data)) return json({ code: "AGENT_RUN_DENIED", message: "Capability does not belong to this AgentRun" }, 403);
      return roomResponse(await room.getAgentRunContext(runId.data));
    }
    if (request.method === "POST" && segments[5] === "heartbeat" && segments.length === 6) {
      const auth = await authorize(request, env, projectId, "agent:write");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (!agentActorOwnsRun(auth.actor, runId.data)) return json({ code: "AGENT_RUN_DENIED", message: "Capability does not belong to this AgentRun" }, 403);
      const result = await room.heartbeatAgentRun(runId.data, await readJson(request));
      if (!result.ok) return roomResponse(result);
      if (!result.value.run.leaseExpiresAt) return json({ code: "AGENT_HEARTBEAT_INVALID", message: "Renewed AgentRun has no lease" }, 409);
      const grant = await mintAgentRunCapability(result.value.run, env);
      return json({ ...result.value, ...grant });
    }
    if (request.method === "POST" && segments[5] === "finish" && segments.length === 6) {
      const auth = await authorize(request, env, projectId, "agent:write");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (!agentActorOwnsRun(auth.actor, runId.data)) return json({ code: "AGENT_RUN_DENIED", message: "Capability does not belong to this AgentRun" }, 403);
      return roomResponse(await room.finishAgentRun(runId.data, await readJson(request)));
    }
    if (request.method === "POST" && segments[5] === "cancel" && segments.length === 6) {
      const auth = await authorize(request, env, projectId, "agent:write");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (!agentActorOwnsRun(auth.actor, runId.data)) return json({ code: "AGENT_RUN_DENIED", message: "Capability does not belong to this AgentRun" }, 403);
      const parsed = AgentRunCancelSchema.safeParse(await readJson(request));
      if (!parsed.success) return json({ code: "INVALID_AGENT_CANCEL", message: parsed.error.message }, 400);
      const result = await room.cancelAgentRun(runId.data, parsed.data.idempotencyKey);
      if (result.ok) {
        const jobs = await room.listJobs();
        if (jobs.ok) {
          for (const job of jobs.value) {
            if (job.actor.runId !== runId.data || !job.jobType.startsWith("render.") || job.status !== "cancel_requested") continue;
            try {
              await requestRenderCancellation(env, job.jobId);
            } catch {
              // The durable Workflow and reconciliation alarm retain the
              // cancellation request if the renderer is between states.
            }
          }
        }
      }
      return roomResponse(result, 202);
    }
  }

  if (request.method === "POST" && segments[3] === "commands" && segments.length === 4) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    const body = await readJson(request);
    const operations = body && typeof body === "object" && Array.isArray((body as { operations?: unknown }).operations)
      ? (body as { operations: unknown[] }).operations
      : [];
    const denied = deniedCommandEntities(operations, auth.actor.deniedEntityIds);
    if (denied.length) return json({ code: "CAPABILITY_ENTITY_DENIED", message: "Capability denies one or more command entities", deniedEntityIds: denied }, 403);
    return roomResponse(await room.applyCommand(
      normalizeCommand(body, projectId, auth.actor),
      { deniedEntityIds: auth.actor.deniedEntityIds, runId: auth.actor.runId },
    ));
  }

  if (request.method === "POST" && (segments[3] === "undo" || segments[3] === "redo") && segments.length === 4) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    if (auth.actor.runId) return json({ code: "AGENT_RUN_OPERATION_DENIED", message: "AgentRuns cannot invoke project history operations" }, 403);
    const parsed = RevisionActionSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_REVISION_ACTION", message: parsed.error.message }, 400);
    const input = {
      ...parsed.data,
      commandId: parsed.data.commandId ?? await stableRequestId(`command_${segments[3]}`, `${projectId}:${parsed.data.idempotencyKey}`),
      actor: actorEnvelope(auth.actor),
      deniedEntityIds: auth.actor.deniedEntityIds,
    };
    return roomResponse(segments[3] === "undo" ? await room.undo(input) : await room.redo(input));
  }

  if (request.method === "POST" && segments[3] === "checkpoints" && segments.length === 4) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    if (auth.actor.runId) return json({ code: "AGENT_RUN_OPERATION_DENIED", message: "AgentRuns cannot create checkpoints" }, 403);
    const parsed = CheckpointCreateSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_CHECKPOINT", message: parsed.error.message }, 400);
    return roomResponse(await room.createCheckpoint({
      ...parsed.data,
      commandId: parsed.data.commandId ?? await stableRequestId("command_checkpoint", `${projectId}:${parsed.data.idempotencyKey}`),
      checkpointId: parsed.data.checkpointId ?? await stableRequestId("checkpoint", `${projectId}:${parsed.data.idempotencyKey}`),
      actor: commandActorEnvelope(parsed.data, auth.actor),
      deniedEntityIds: auth.actor.deniedEntityIds,
    }), 201);
  }

  if (request.method === "POST" && segments[3] === "checkpoints" && segments[5] === "restore" && segments.length === 6) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    if (auth.actor.runId) return json({ code: "AGENT_RUN_OPERATION_DENIED", message: "AgentRuns cannot restore checkpoints" }, 403);
    const checkpointId = StableIdSchema.safeParse(segments[4]);
    const parsed = RestoreSchema.safeParse(await readJson(request));
    if (!checkpointId.success) return json({ code: "INVALID_CHECKPOINT_RESTORE", message: checkpointId.error.message }, 400);
    if (!parsed.success) return json({ code: "INVALID_CHECKPOINT_RESTORE", message: parsed.error.message }, 400);
    if (auth.actor.deniedEntityIds.includes(checkpointId.data)) {
      return json({ code: "CAPABILITY_ENTITY_DENIED", message: "Capability denies the requested checkpoint", deniedEntityIds: [checkpointId.data] }, 403);
    }
    return roomResponse(await room.restoreCheckpoint({
      ...parsed.data,
      commandId: parsed.data.commandId ?? await stableRequestId("command_restore", `${projectId}:${parsed.data.idempotencyKey}`),
      checkpointId: checkpointId.data,
      actor: actorEnvelope(auth.actor),
      deniedEntityIds: auth.actor.deniedEntityIds,
    }));
  }

  if (segments[3] === "jobs") {
    if (request.method === "GET" && segments.length === 4) {
      const auth = await authorize(request, env, projectId, "job:read");
      const failure = authFailure(auth);
      if (failure) return failure;
      const result = await room.listJobs();
      return result.ok ? json({ jobs: auth.ok && !auth.actor.owner && auth.actor.runId ? result.value.filter((job) => job.actor.runId === auth.actor.runId) : result.value }) : roomResponse(result);
    }
    if (request.method === "POST" && segments.length === 4) {
      const auth = await authorize(request, env, projectId, "job:create");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      const raw = await readJson(request);
      const parsed = JobCreateRequestSchema.safeParse(raw);
      if (!parsed.success) return json({ code: "INVALID_JOB", message: parsed.error.message }, 400);
      const denied = deniedCommandEntities([parsed.data], auth.actor.deniedEntityIds);
      if (denied.length) return json({ code: "CAPABILITY_ENTITY_DENIED", message: "Capability denies a job target", deniedEntityIds: denied }, 403);
      const provider = env.PRAXIS_PROVIDER_MODE ?? "fake";
      const normalized = parsed.data.jobType === "image.generate" || parsed.data.jobType === "speech.generate"
        ? { ...parsed.data, request: { ...parsed.data.request, provider } }
        : parsed.data;
      const created = await room.createJob(normalized, jobActor(auth.actor));
      if (
        created.ok &&
        !created.value.job.workflowId &&
        !["succeeded", "failed", "cancelled"].includes(created.value.job.status)
      ) {
        try {
          await startWorkflow(env, projectId, created.value.job.jobId, created.value.job.jobType);
        } catch (error) {
          await room.transitionJob(created.value.job.jobId, {
            expectedStatuses: ["queued"],
            status: "failed",
            errorCode: "WORKFLOW_START_FAILED",
            errorMessage: error instanceof Error ? error.message.slice(0, 1_000) : "Workflow could not be started",
          });
          const failed = await room.getJob(created.value.job.jobId);
          return failed.ok ? json({ job: failed.value }, 202) : roomResponse(failed);
        }
      }
      if (created.ok) {
        const current = await room.getJob(created.value.job.jobId);
        if (current.ok) return json({ ...created.value, job: current.value }, 202);
      }
      return roomResponse(created, 202);
    }
    const jobId = StableIdSchema.safeParse(segments[4]);
    if (!jobId.success) return json({ code: "INVALID_JOB_ID", message: "Job ID is invalid" }, 400);
    if (request.method === "GET" && segments.length === 5) {
      const auth = await authorize(request, env, projectId, "job:read");
      const failure = authFailure(auth);
      if (failure) return failure;
      const result = await room.getJob(jobId.data);
      if (result.ok && auth.ok && !auth.actor.owner && auth.actor.runId && result.value.actor.runId !== auth.actor.runId) {
        return json({ code: "AGENT_RUN_JOB_DENIED", message: "AgentRun cannot read another actor's job" }, 403);
      }
      return result.ok ? json({ job: result.value }) : roomResponse(result);
    }
    if (request.method === "POST" && segments[5] === "cancel" && segments.length === 6) {
      const auth = await authorize(request, env, projectId, "job:cancel");
      const failure = authFailure(auth);
      if (failure || !auth.ok) return failure!;
      if (auth.actor.runId) {
        const owned = await room.getJob(jobId.data);
        if (!owned.ok) return roomResponse(owned);
        if (owned.value.actor.runId !== auth.actor.runId) return json({ code: "AGENT_RUN_JOB_DENIED", message: "AgentRun cannot cancel another actor's job" }, 403);
      }
      const result = await room.cancelJob(jobId.data);
      if (result.ok && result.value.job.jobType.startsWith("render.") && result.value.job.status === "cancel_requested") {
        try {
          await requestRenderCancellation(env, jobId.data);
        } catch {
          // The durable workflow observes cancel_requested even if the worker is between dispatch states.
        }
      }
      return result.ok ? json(result.value, 202) : roomResponse(result);
    }
  }

  if (request.method === "GET" && segments[3] === "events" && segments.length === 4) {
    const auth = await authorize(request, env, projectId, "project:read");
    const failure = authFailure(auth);
    if (failure) return failure;
    return room.fetch(new Request(`https://project-room/events${url.search}`, { headers: { "last-event-id": request.headers.get("last-event-id") ?? "" } }));
  }

  if (request.method === "GET" && segments[3] === "assets" && segments[5] === "access" && segments.length === 6) {
    const auth = await authorize(request, env, projectId, "asset:read");
    const failure = authFailure(auth);
    if (failure) return failure;
    const assetVersionId = StableIdSchema.safeParse(segments[4]);
    if (!assetVersionId.success) return json({ code: "INVALID_ASSET_VERSION_ID", message: "Asset version ID is invalid" }, 400);
    const record = await room.getAssetByVersion(assetVersionId.data);
    if (!record.ok) return roomResponse(record);
    const object = await requireMediaBinding(env).get(record.value.objectKey, { onlyIf: request.headers });
    if (!object || !("body" in object) || !object.body) return json({ code: "OBJECT_NOT_FOUND", message: "Immutable media object is missing" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("x-praxis-sha256", record.value.sha256);
    headers.set("cache-control", "private, max-age=31536000, immutable");
    headers.set("content-length", String(record.value.byteLength));
    return new Response(object.body, { headers });
  }

  if (request.method === "POST" && segments[3] === "uploads" && segments[4] === "finalize" && segments.length === 5) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    if (auth.actor.runId) return json({ code: "AGENT_RUN_OPERATION_DENIED", message: "AgentRuns cannot register direct uploads" }, 403);
    const parsed = DirectUploadFinalizeSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_UPLOAD_FINALIZATION", message: parsed.error.message }, 400);
    const denied = deniedCommandEntities([parsed.data], auth.actor.deniedEntityIds);
    if (denied.length) {
      return json({ code: "CAPABILITY_ENTITY_DENIED", message: "Capability denies the upload target", deniedEntityIds: denied }, 403);
    }

    const objectKey = directUploadObjectKey(projectId, parsed.data);
    const object = await requireMediaBinding(env).head(objectKey);
    if (!object) return json({ code: "UPLOAD_OBJECT_NOT_FOUND", message: "The initiated object has not been uploaded to R2" }, 404);
    const verification = verifyDirectUploadObject(object, parsed.data);
    if (!verification.ok) return json({ code: verification.code, message: verification.message }, verification.status);

    const hydration = await room.getHydration();
    if (!hydration.ok) return roomResponse(hydration);
    const canonicalAsset = hydration.value.project.assets[parsed.data.assetId];
    if (canonicalAsset && canonicalAsset.kind !== parsed.data.kind) {
      return json({ code: "UPLOAD_ASSET_KIND_MISMATCH", message: "The canonical asset has a different kind" }, 409);
    }
    for (const asset of Object.values(hydration.value.project.assets)) {
      const version = asset.versions.find((candidate) => candidate.id === parsed.data.assetVersionId);
      if (!version) continue;
      if (asset.meta.id !== parsed.data.assetId) {
        return json({ code: "UPLOAD_VERSION_ID_CONFLICT", message: "The asset version ID is already used by another asset" }, 409);
      }
      if (
        version.objectKey !== objectKey ||
        version.sha256 !== parsed.data.sha256 ||
        version.byteLength !== parsed.data.byteLength ||
        version.mimeType !== parsed.data.mimeType ||
        version.width !== parsed.data.width ||
        version.height !== parsed.data.height ||
        version.durationMs !== parsed.data.durationMs
      ) {
        return json({ code: "UPLOAD_VERSION_IMMUTABLE", message: "The canonical asset version references different immutable content" }, 409);
      }
    }

    const proposedRecord = persistedUploadRecord(projectId, objectKey, parsed.data, new Date().toISOString(), {
      kind: auth.actor.kind,
      id: auth.actor.id,
      runId: auth.actor.runId,
    });
    const current = await room.getAssetByVersion(parsed.data.assetVersionId);
    let record = proposedRecord;
    let idempotentReplay = false;
    if (current.ok) {
      if (!sameImmutableUploadRecord(current.value, proposedRecord)) {
        return json({ code: "ASSET_VERSION_IMMUTABLE", message: "Asset version already exists with different immutable metadata" }, 409);
      }
      record = current.value;
      idempotentReplay = true;
    } else if (current.status !== 404) {
      return roomResponse(current);
    } else {
      const persisted = await room.recordAsset(proposedRecord);
      if (!persisted.ok) return roomResponse(persisted);
      if (!sameImmutableUploadRecord(persisted.value, proposedRecord)) {
        return json({ code: "ASSET_VERSION_IMMUTABLE", message: "Asset version already exists with different immutable metadata" }, 409);
      }
      record = persisted.value;
    }

    const operations = directUploadCommandOperations(hydration.value.project, record, parsed.data.name);
    const command = operations.length > 0
      ? {
          commandId: await stableRequestId("command_upload", `${projectId}:${record.assetVersionId}`),
          idempotencyKey: `upload:${record.assetVersionId}`,
          baseRevision: hydration.value.project.revision,
          reason: `Register direct upload ${record.assetVersionId}`,
          operations,
        }
      : undefined;
    return json({
      asset: record,
      idempotentReplay,
      verifiedBy: "r2-sha256-checksum",
      command,
    }, idempotentReplay ? 200 : 201);
  }

  if (request.method === "POST" && segments[3] === "uploads" && segments.length === 4) {
    const auth = await authorize(request, env, projectId, "command:write");
    const failure = authFailure(auth);
    if (failure || !auth.ok) return failure!;
    if (auth.actor.runId) return json({ code: "AGENT_RUN_OPERATION_DENIED", message: "AgentRuns cannot initiate direct uploads" }, 403);
    const parsed = DirectUploadRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ code: "INVALID_UPLOAD", message: parsed.error.message }, 400);
    const denied = deniedCommandEntities([parsed.data], auth.actor.deniedEntityIds);
    if (denied.length) {
      return json({ code: "CAPABILITY_ENTITY_DENIED", message: "Capability denies the upload target", deniedEntityIds: denied }, 403);
    }
    if (!hasR2PresigningConfiguration(env)) {
      return json(
        {
          code: "DIRECT_UPLOAD_CONFIGURATION_REQUIRED",
          message: "Direct uploads require R2 S3 presigning credentials in this environment",
          requiredConfiguration: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"],
        },
        503,
      );
    }
    const objectKey = directUploadObjectKey(projectId, parsed.data);
    const existing = await requireMediaBinding(env).head(objectKey);
    if (existing) {
      const verification = verifyDirectUploadObject(existing, parsed.data);
      if (!verification.ok) return json({ code: verification.code, message: verification.message }, verification.status);
      return json({
        objectKey,
        alreadyExists: true,
        byteLength: existing.size,
        mimeType: parsed.data.mimeType,
        sha256: parsed.data.sha256,
        finalizeUrl: `/api/projects/${projectId}/uploads/finalize`,
      });
    }
    const upload = await presignR2Object(env, {
      objectKey,
      method: "PUT",
      contentType: parsed.data.mimeType,
      checksumSha256: parsed.data.sha256,
      expiresInSeconds: 900,
    });
    return json({
      objectKey,
      alreadyExists: false,
      uploadUrl: upload.url,
      method: upload.method,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
      expectedByteLength: parsed.data.byteLength,
      sha256: parsed.data.sha256,
      finalizeUrl: `/api/projects/${projectId}/uploads/finalize`,
    }, 201);
  }

  return json({ code: "NOT_FOUND", message: "Route does not exist" }, 404);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await route(request, env), request, env);
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") return withCors(json({ code: "REQUEST_TOO_LARGE", message: "JSON request exceeds 1 MB" }, 413), request, env);
      if (error instanceof Error && error.message === "INVALID_JSON") return withCors(json({ code: "INVALID_JSON", message: "Request body is not valid JSON" }, 400), request, env);
      return withCors(json({ code: "INTERNAL_ERROR", message: "The control plane could not complete the request" }, 500), request, env);
    }
  },
} satisfies ExportedHandler<Env>;
