import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import demoWorker, { type DemoEnv } from "../src/demo";
import {
  classifyDemoApiRequest,
  demoBasicAuthorizationValid,
  demoMutationOriginAllowed,
  deriveDemoInternalOwnerSecret,
  PRAXIS_DEMO_PROJECT_ID,
} from "../src/demo-policy";

const accessSecret = "test-only-praxis-demo-access-secret-0001";
const request = (path: string, init?: RequestInit) => new Request(`https://praxis.example${path}`, init);
const authorization = `Basic ${btoa(`praxis:${accessSecret}`)}`;

const testEnv = env as Cloudflare.Env & { ASSETS: Fetcher };
const handlerEnv = (overrides: Partial<DemoEnv> = {}) => ({
  PRAXIS_DEMO_USERNAME: "praxis",
  PRAXIS_DEMO_PASSWORD: accessSecret,
  ASSETS: {
    fetch: async () => new Response("studio asset", { headers: { "content-type": "text/plain" } }),
  },
  ...overrides,
} as DemoEnv);

describe("no-API demo policy", () => {
  it("accepts only the configured Basic credential", async () => {
    await expect(demoBasicAuthorizationValid(request("/", { headers: { authorization } }), "praxis", accessSecret)).resolves.toBe(true);
    await expect(demoBasicAuthorizationValid(request("/"), "praxis", accessSecret)).resolves.toBe(false);
    await expect(demoBasicAuthorizationValid(request("/", {
      headers: { authorization: `Basic ${btoa("praxis:incorrect-secret")}` },
    }), "praxis", accessSecret)).resolves.toBe(false);
    await expect(demoBasicAuthorizationValid(request("/", {
      headers: { authorization: `Basic ${btoa(`other:${accessSecret}`)}` },
    }), "praxis", accessSecret)).resolves.toBe(false);
  });

  it("derives a stable, domain-separated internal owner value", async () => {
    const derived = await deriveDemoInternalOwnerSecret(accessSecret);
    expect(derived).toHaveLength(64);
    expect(derived).not.toContain(accessSecret);
    await expect(deriveDemoInternalOwnerSecret(accessSecret)).resolves.toBe(derived);
  });

  it("allows only fixed-project read, edit, history, checkpoint, event, and media routes", () => {
    const project = `/api/projects/${PRAXIS_DEMO_PROJECT_ID}`;
    expect(classifyDemoApiRequest(request(project))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/events`))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/assets/version_seed/access`))).toBe("forbidden");
    expect(classifyDemoApiRequest(request(`${project}/commands`, { method: "POST" }))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/undo`, { method: "POST" }))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/redo`, { method: "POST" }))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/checkpoints`, { method: "POST" }))).toBe("allow");
    expect(classifyDemoApiRequest(request(`${project}/checkpoints/checkpoint_seed/restore`, { method: "POST" }))).toBe("allow");
  });

  it("forbids other projects and disabled mutation surfaces", () => {
    const project = `/api/projects/${PRAXIS_DEMO_PROJECT_ID}`;
    expect(classifyDemoApiRequest(request("/api/projects/other_project"))).toBe("forbidden");
    expect(classifyDemoApiRequest(request("/api/projects", { method: "POST" }))).toBe("forbidden");
    expect(classifyDemoApiRequest(request(`${project}/jobs`, { method: "POST" }))).toBe("forbidden");
    expect(classifyDemoApiRequest(request(`${project}/uploads`, { method: "POST" }))).toBe("forbidden");
    expect(classifyDemoApiRequest(request(`${project}/agent-runs`, { method: "POST" }))).toBe("forbidden");
    expect(classifyDemoApiRequest(request("/api/capabilities", { method: "POST" }))).toBe("not_found");
    expect(classifyDemoApiRequest(request("/internal/agent-dispatch/lease", { method: "POST" }))).toBe("not_found");
    expect(classifyDemoApiRequest(request("/auth/session", { method: "POST" }))).toBe("not_found");
  });

  it("requires the exact request origin for every mutation", () => {
    expect(demoMutationOriginAllowed(request("/api/project"))).toBe(true);
    expect(demoMutationOriginAllowed(request("/api/project", {
      method: "POST",
      headers: { origin: "https://praxis.example" },
    }))).toBe(true);
    expect(demoMutationOriginAllowed(request("/api/project", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }))).toBe(false);
    expect(demoMutationOriginAllowed(request("/api/project", { method: "POST" }))).toBe(false);
  });

  it("challenges before serving assets and fails closed when auth is unconfigured", async () => {
    const unconfigured = await demoWorker.fetch(request("/"), handlerEnv({ PRAXIS_DEMO_PASSWORD: undefined }));
    expect(unconfigured.status).toBe(503);
    const unauthorized = await demoWorker.fetch(request("/"), handlerEnv());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");
    const asset = await demoWorker.fetch(request("/", { headers: { authorization } }), handlerEnv());
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("studio asset");
  });

  it("denies disabled APIs and cross-origin mutations before touching storage", async () => {
    const disabled = await demoWorker.fetch(request(
      `/api/projects/${PRAXIS_DEMO_PROJECT_ID}/jobs`,
      { method: "POST", headers: { authorization, origin: "https://praxis.example" } },
    ), handlerEnv());
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({ code: "DEMO_FEATURE_DISABLED" });

    const crossOrigin = await demoWorker.fetch(request(
      `/api/projects/${PRAXIS_DEMO_PROJECT_ID}/commands`,
      { method: "POST", headers: { authorization, origin: "https://attacker.example" } },
    ), handlerEnv());
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ code: "DEMO_ORIGIN_DENIED" });

    const ownerOnly = await demoWorker.fetch(request("/api/capabilities", {
      method: "POST",
      headers: { authorization, origin: "https://praxis.example" },
    }), handlerEnv());
    expect(ownerOnly.status).toBe(404);
  });

  it("seeds the fixed durable project and serves bundled fallback media without R2", async () => {
    const deployedEnv: DemoEnv = {
      PROJECT_ROOMS: testEnv.PROJECT_ROOMS,
      ASSETS: testEnv.ASSETS,
      PRAXIS_DEMO_USERNAME: "praxis",
      PRAXIS_DEMO_PASSWORD: accessSecret,
    };
    const response = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`, {
      headers: { authorization },
    }), deployedEnv);
    expect(response.status).toBe(200);
    const hydration = await response.json<{
      project: { projectId: string; revision: number };
      assets: Array<{ assetVersionId: string }>;
    }>();
    expect(hydration.project).toMatchObject({ projectId: PRAXIS_DEMO_PROJECT_ID, revision: 1 });
    expect(hydration.assets).toEqual([]);

    const assetResponse = await demoWorker.fetch(request("/media/fax-oracle-corridor.png", {
      headers: { authorization },
    }), deployedEnv);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toBe("image/png");

    const r2AssetResponse = await demoWorker.fetch(request(
      `/api/projects/${PRAXIS_DEMO_PROJECT_ID}/assets/asset_scene_01_v1/access`,
      { headers: { authorization } },
    ), deployedEnv);
    expect(r2AssetResponse.status).toBe(403);
    await expect(r2AssetResponse.json()).resolves.toMatchObject({ code: "DEMO_FEATURE_DISABLED" });
  });

  it("attributes UI edits to the director and WebMCP edits to Codex", async () => {
    const deployedEnv: DemoEnv = {
      PROJECT_ROOMS: testEnv.PROJECT_ROOMS,
      ASSETS: testEnv.ASSETS,
      PRAXIS_DEMO_USERNAME: "praxis",
      PRAXIS_DEMO_PASSWORD: accessSecret,
    };
    const command = async (baseRevision: number, beatId: string, narration: string, actorKind: "director" | "codex") => {
      const response = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}/commands`, {
        method: "POST",
        headers: { authorization, origin: "https://praxis.example", "content-type": "application/json" },
        body: JSON.stringify({
          commandId: `command_demo_actor_${baseRevision}`,
          idempotencyKey: `demo-actor-${baseRevision}`,
          baseRevision,
          actor: { kind: actorKind, sessionId: "untrusted-browser-value" },
          reason: "Demo actor attribution",
          createdAt: "2026-09-03T16:00:00.000Z",
          operations: [{ type: "script.updateBeat", beatId, patch: { narration } }],
        }),
      }), deployedEnv);
      expect(response.status).toBe(200);
    };

    await command(1, "beat_01", "Director edit.", "director");
    await command(2, "beat_02", "WebMCP edit.", "codex");
    const hydrationResponse = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`, {
      headers: { authorization },
    }), deployedEnv);
    const hydration = await hydrationResponse.json<{ history: { entries: Array<{ actorKind: string }> } }>();
    expect(hydration.history.entries.map((entry) => entry.actorKind)).toEqual(["director", "codex"]);
  });

  it("attributes UI checkpoints to the director, WebMCP checkpoints to Codex, and rejects system elevation", async () => {
    const deployedEnv: DemoEnv = {
      PROJECT_ROOMS: testEnv.PROJECT_ROOMS,
      ASSETS: testEnv.ASSETS,
      PRAXIS_DEMO_USERNAME: "praxis",
      PRAXIS_DEMO_PASSWORD: accessSecret,
    };
    const createCheckpoint = async (
      baseRevision: number,
      checkpointId: string,
      actor?: { kind: "codex" | "system" },
    ) => demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}/checkpoints`, {
      method: "POST",
      headers: { authorization, origin: "https://praxis.example", "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command_${checkpointId}`,
        checkpointId,
        idempotencyKey: `idempotency-${checkpointId}`,
        baseRevision,
        label: checkpointId,
        ...(actor ? { actor } : {}),
      }),
    }), deployedEnv);

    const initialResponse = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`, {
      headers: { authorization },
    }), deployedEnv);
    const initial = await initialResponse.json<{ project: { revision: number } }>();
    expect((await createCheckpoint(initial.project.revision, "checkpoint_director_demo")).status).toBe(201);
    expect((await createCheckpoint(initial.project.revision + 1, "checkpoint_webmcp_demo", { kind: "codex" })).status).toBe(201);
    const elevated = await createCheckpoint(initial.project.revision + 2, "checkpoint_system_demo", { kind: "system" });
    expect(elevated.status).toBe(400);
    await expect(elevated.json()).resolves.toMatchObject({ code: "INVALID_CHECKPOINT" });

    const hydrationResponse = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`, {
      headers: { authorization },
    }), deployedEnv);
    const hydration = await hydrationResponse.json<{
      checkpoints: Array<{ checkpointId: string; createdBy: string }>;
    }>();
    expect(hydration.checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkpointId: "checkpoint_director_demo", createdBy: "director" }),
      expect.objectContaining({ checkpointId: "checkpoint_webmcp_demo", createdBy: "codex" }),
    ]));
    expect(hydration.checkpoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ checkpointId: "checkpoint_system_demo" }),
    ]));
  });
});
