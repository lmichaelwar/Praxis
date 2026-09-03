import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import demoWorker, { type DemoEnv } from "../src/demo";
import {
  classifyDemoApiRequest,
  demoBasicAuthorizationValid,
  demoMutationOriginAllowed,
  deriveDemoInternalOwnerSecret,
  PRAXIS_DEMO_LOGIN_CSRF_COOKIE,
  PRAXIS_DEMO_LOGIN_MAX_BODY_BYTES,
  PRAXIS_DEMO_PROJECT_ID,
  PRAXIS_DEMO_SESSION_COOKIE,
} from "../src/demo-policy";

const accessSecret = "test-only-praxis-demo-access-secret-0001";
const request = (path: string, init?: RequestInit) => new Request(`https://praxis.example${path}`, init);
const httpRequest = (path: string, init?: RequestInit) => new Request(`http://praxis.example${path}`, init);
const authorization = `Basic ${btoa(`praxis:${accessSecret}`)}`;
const loginRequest = (body: string, headers: HeadersInit = {}) => request("/login", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...headers,
  },
  body,
});
const validLoginBody = (csrfToken: string) => new URLSearchParams({
  csrf_token: csrfToken,
  username: "praxis",
  password: accessSecret,
}).toString();

const testEnv = env as Cloudflare.Env & { ASSETS: Fetcher };
const handlerEnv = (overrides: Partial<DemoEnv> = {}) => ({
  PROJECT_ROOMS: testEnv.PROJECT_ROOMS,
  PRAXIS_DEMO_USERNAME: "praxis",
  PRAXIS_DEMO_PASSWORD: accessSecret,
  ASSETS: {
    fetch: async () => new Response("studio asset", { headers: { "content-type": "text/plain" } }),
  },
  ...overrides,
} as DemoEnv);

const getLoginHandshake = async (path = "/") => {
  const response = await demoWorker.fetch(request(path), handlerEnv());
  const html = await response.text();
  const token = html.match(/name="csrf_token" type="hidden" value="([a-f0-9]{64})"/u)?.[1];
  if (!token) throw new Error("Login page did not contain a CSRF token");
  const setCookie = response.headers.getSetCookie().find((value) =>
    value.startsWith(`${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=`));
  if (!setCookie) throw new Error("Login page did not set a CSRF cookie");
  return {
    cookie: setCookie.split(";", 1)[0]!,
    html,
    response,
    setCookie,
    token,
  };
};

describe("no-API demo policy", () => {
  it("redirects safe HTTP requests to the identical HTTPS URL and rejects HTTP request bodies", async () => {
    const get = await demoWorker.fetch(httpRequest("/login?from=judge%20view"), handlerEnv({
      PRAXIS_DEMO_PASSWORD: undefined,
    }));
    expect(get.status).toBe(308);
    expect(get.headers.get("location")).toBe("https://praxis.example/login?from=judge%20view");
    expect(get.headers.get("set-cookie")).toBeNull();

    const head = await demoWorker.fetch(httpRequest("/?from=head", { method: "HEAD" }), handlerEnv({
      PRAXIS_DEMO_PASSWORD: undefined,
    }));
    expect(head.status).toBe(308);
    expect(head.headers.get("location")).toBe("https://praxis.example/?from=head");
    await expect(head.text()).resolves.toBe("");

    const attemptedPassword = "credential-that-must-not-be-redirected-or-echoed";
    const post = await demoWorker.fetch(httpRequest("/login?from=judge", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "praxis", password: attemptedPassword }),
    }), handlerEnv({ PRAXIS_DEMO_PASSWORD: undefined }));
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await post.text()).not.toContain(attemptedPassword);
  });

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

  it("serves an accessible in-page login while keeping APIs and media protected", async () => {
    const unconfigured = await demoWorker.fetch(request("/"), handlerEnv({ PRAXIS_DEMO_PASSWORD: undefined }));
    expect(unconfigured.status).toBe(503);

    const { response: login, html: loginHtml, setCookie, token } = await getLoginHandshake();
    expect(login.status).toBe(200);
    expect(login.headers.get("content-type")).toContain("text/html");
    expect(login.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(login.headers.get("www-authenticate")).toBeNull();
    expect(loginHtml).toContain("Praxis production demo");
    expect(loginHtml).toContain(`name="csrf_token" type="hidden" value="${token}"`);
    expect(loginHtml).toContain('<label for="username">Username</label>');
    expect(loginHtml).toContain('<label for="password">Password</label>');
    expect(loginHtml).not.toContain("<script");
    expect(loginHtml).not.toContain(accessSecret);
    expect(setCookie).toMatch(new RegExp(`^${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=${token};`, "u"));
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("Domain=");

    const unauthorizedApi = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`), handlerEnv());
    expect(unauthorizedApi.status).toBe(401);
    expect(unauthorizedApi.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(unauthorizedApi.headers.get("www-authenticate")).toBeNull();
    const unauthorizedMedia = await demoWorker.fetch(request("/media/fax-oracle-corridor.png"), handlerEnv());
    expect(unauthorizedMedia.status).toBe(401);

    const asset = await demoWorker.fetch(request("/", { headers: { authorization } }), handlerEnv());
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("studio asset");
  });

  it("keeps invalid form credentials fail-closed without echoing them", async () => {
    const handshake = await getLoginHandshake("/login");
    const attemptedPassword = "incorrect-password-value-that-is-long-enough";
    const response = await demoWorker.fetch(loginRequest(new URLSearchParams({
      csrf_token: handshake.token,
      username: "praxis",
      password: attemptedPassword,
    }).toString(), { cookie: handshake.cookie }), handlerEnv());
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().some((value) =>
      value.startsWith(`${PRAXIS_DEMO_SESSION_COOKIE}=`))).toBe(false);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain(attemptedPassword);
    expect(html).not.toContain(accessSecret);
  });

  it("sets a derived secure HttpOnly cookie and accepts it for assets and APIs", async () => {
    const handshake = await getLoginHandshake();
    const login = await demoWorker.fetch(loginRequest(validLoginBody(handshake.token), {
      cookie: handshake.cookie,
      origin: "https://foreign-webview-origin.example",
    }), handlerEnv());
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const setCookies = login.headers.getSetCookie();
    const sessionCookie = setCookies.find((value) => value.startsWith(`${PRAXIS_DEMO_SESSION_COOKIE}=`)) ?? "";
    const clearedCsrfCookie = setCookies.find((value) =>
      value.startsWith(`${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=`)) ?? "";
    expect(sessionCookie).toMatch(new RegExp(`^${PRAXIS_DEMO_SESSION_COOKIE}=[a-f0-9]{64};`, "u"));
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).toContain("Max-Age=14400");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).not.toContain(accessSecret);
    expect(clearedCsrfCookie).toContain(`${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=;`);
    expect(clearedCsrfCookie).toContain("Path=/");
    expect(clearedCsrfCookie).toContain("HttpOnly");
    expect(clearedCsrfCookie).toContain("SameSite=Strict");
    expect(clearedCsrfCookie).toContain("Max-Age=0");
    expect(clearedCsrfCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(clearedCsrfCookie).toContain("Secure");
    expect(clearedCsrfCookie).not.toContain("Domain=");
    const cookie = sessionCookie.split(";", 1)[0]!;

    const asset = await demoWorker.fetch(request("/", { headers: { cookie } }), handlerEnv());
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("studio asset");
    const project = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}`, {
      headers: { cookie },
    }), handlerEnv());
    expect(project.status).toBe(200);
  });

  it("rejects malformed and oversized login bodies before credential validation", async () => {
    const wrongMediaType = await demoWorker.fetch(request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "praxis", password: accessSecret }),
    }), handlerEnv());
    expect(wrongMediaType.status).toBe(415);

    const handshake = await getLoginHandshake();
    const duplicate = await demoWorker.fetch(loginRequest(
      `csrf_token=${handshake.token}&username=praxis&username=other&password=${encodeURIComponent(accessSecret)}`,
      { cookie: handshake.cookie },
    ), handlerEnv());
    expect(duplicate.status).toBe(400);

    const duplicateCsrf = await demoWorker.fetch(loginRequest(
      `${validLoginBody(handshake.token)}&csrf_token=${"b".repeat(64)}`,
      { cookie: handshake.cookie },
    ), handlerEnv());
    expect(duplicateCsrf.status).toBe(400);

    const extra = await demoWorker.fetch(loginRequest(
      `${validLoginBody(handshake.token)}&redirect=%2Fadmin`,
      { cookie: handshake.cookie },
    ), handlerEnv());
    expect(extra.status).toBe(400);

    const oversized = await demoWorker.fetch(loginRequest(
      `username=praxis&password=${"x".repeat(PRAXIS_DEMO_LOGIN_MAX_BODY_BYTES)}`,
    ), handlerEnv());
    expect(oversized.status).toBe(413);
  });

  it("accepts foreign or missing Origin only when the form and cookie CSRF tokens match", async () => {
    const foreignOriginHandshake = await getLoginHandshake();
    const foreignOrigin = await demoWorker.fetch(loginRequest(validLoginBody(foreignOriginHandshake.token), {
      cookie: foreignOriginHandshake.cookie,
      origin: "https://chatgpt.com",
    }), handlerEnv());
    expect(foreignOrigin.status).toBe(303);

    const missingOriginHandshake = await getLoginHandshake();
    const missingOrigin = await demoWorker.fetch(loginRequest(validLoginBody(missingOriginHandshake.token), {
      cookie: missingOriginHandshake.cookie,
    }), handlerEnv());
    expect(missingOrigin.status).toBe(303);

    const crossSiteWithoutCookie = await demoWorker.fetch(loginRequest(validLoginBody(foreignOriginHandshake.token), {
      origin: "https://attacker.example",
    }), handlerEnv());
    expect(crossSiteWithoutCookie.status).toBe(403);
    expect(crossSiteWithoutCookie.headers.getSetCookie().some((value) =>
      value.startsWith(`${PRAXIS_DEMO_SESSION_COOKIE}=`))).toBe(false);

    const wrongTokenHandshake = await getLoginHandshake();
    const wrongToken = await demoWorker.fetch(loginRequest(validLoginBody("a".repeat(64)), {
      cookie: wrongTokenHandshake.cookie,
      origin: "https://attacker.example",
    }), handlerEnv());
    expect(wrongToken.status).toBe(403);

    const missingTokenHandshake = await getLoginHandshake();
    const missingToken = await demoWorker.fetch(loginRequest(new URLSearchParams({
      username: "praxis",
      password: accessSecret,
    }).toString(), {
      cookie: missingTokenHandshake.cookie,
      origin: "https://attacker.example",
    }), handlerEnv());
    expect(missingToken.status).toBe(403);
  });

  it("still requires exact Origin for cookie-authenticated mutations", async () => {
    const handshake = await getLoginHandshake();
    const login = await demoWorker.fetch(loginRequest(validLoginBody(handshake.token), {
      cookie: handshake.cookie,
    }), handlerEnv());
    const cookie = (login.headers.getSetCookie().find((value) =>
      value.startsWith(`${PRAXIS_DEMO_SESSION_COOKIE}=`)) ?? "").split(";", 1)[0]!;
    const mutation = await demoWorker.fetch(request(`/api/projects/${PRAXIS_DEMO_PROJECT_ID}/commands`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    }), handlerEnv());
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ code: "DEMO_ORIGIN_DENIED" });
  });

  it("fails closed on the login route when the demo secret is absent", async () => {
    const response = await demoWorker.fetch(loginRequest(validLoginBody("a".repeat(64)), {
      cookie: `${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=${"a".repeat(64)}`,
    }), handlerEnv({
      PRAXIS_DEMO_PASSWORD: undefined,
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
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
