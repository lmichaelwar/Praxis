import { createSeedProject } from "@praxis/project-schema";
import coreWorker from "./index";
import type { Env } from "./env";
import { ProjectRoom, type ProjectRoomClient } from "./project-room";
import {
  classifyDemoApiRequest,
  demoBasicAuthorizationValid,
  demoCredentialsValid,
  demoMutationOriginAllowed,
  demoSessionAuthorizationValid,
  demoSessionCookie,
  deriveDemoInternalOwnerSecret,
  PRAXIS_DEMO_LOGIN_PATH,
  PRAXIS_DEMO_PROJECT_ID,
  readDemoLoginCredentials,
} from "./demo-policy";

export { ProjectRoom };

export interface DemoEnv {
  PROJECT_ROOMS: DurableObjectNamespace<ProjectRoom>;
  ASSETS: Fetcher;
  PRAXIS_DEMO_USERNAME?: string;
  PRAXIS_DEMO_PASSWORD?: string;
}

const json = (body: unknown, status: number, headers?: HeadersInit) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

const unauthorized = () => json(
  { code: "DEMO_AUTH_REQUIRED", message: "Praxis demo authentication is required" },
  401,
);

const loginPage = (status = 200, showError = false) => new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Praxis Demo · Sign in</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #fafafa; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #27272a, #09090b 58%); }
    main { width: min(100%, 420px); padding: 32px; border: 1px solid #3f3f46; border-radius: 16px; background: #18181b; box-shadow: 0 24px 80px #0008; }
    .eyebrow { margin: 0 0 8px; color: #a1a1aa; font-size: .75rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0 0 8px; font-size: 2rem; }
    .lede { margin: 0 0 24px; color: #d4d4d8; line-height: 1.5; }
    label { display: block; margin-top: 16px; font-weight: 650; }
    input { width: 100%; margin-top: 7px; padding: 12px; border: 1px solid #52525b; border-radius: 8px; background: #09090b; color: #fafafa; font: inherit; }
    input:focus { outline: 3px solid #a78bfa66; border-color: #a78bfa; }
    button { width: 100%; margin-top: 24px; padding: 12px 16px; border: 0; border-radius: 8px; background: #8b5cf6; color: white; font: inherit; font-weight: 750; cursor: pointer; }
    .error { padding: 10px 12px; border: 1px solid #f87171; border-radius: 8px; background: #7f1d1d55; color: #fecaca; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Frictionwerks</p>
    <h1>Praxis production demo</h1>
    <p class="lede">Sign in to open the shared, durable production workspace.</p>
    ${showError ? '<p class="error" role="alert">Sign-in failed. Check the credentials and try again.</p>' : ""}
    <form method="post" action="${PRAXIS_DEMO_LOGIN_PATH}">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" maxlength="128" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required>
      <button type="submit">Open Praxis</button>
    </form>
  </main>
</body>
</html>`, {
  status,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  },
});

const forwardDemoAsset = (request: Request, env: DemoEnv): Promise<Response> => {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  return env.ASSETS.fetch(new Request(request, { headers }));
};

const ensureDemoProject = async (env: DemoEnv): Promise<void> => {
  const room: ProjectRoomClient = env.PROJECT_ROOMS.getByName(PRAXIS_DEMO_PROJECT_ID);
  const current = await room.getHydration();
  if (!current.ok && (current.status !== 404 || current.error.code !== "PROJECT_NOT_FOUND")) {
    throw new Error(`Demo project hydration failed: ${current.error.code}`);
  }
  const project = current.ok ? current.value.project : createSeedProject();
  if (project.projectId !== PRAXIS_DEMO_PROJECT_ID) throw new Error("Demo seed project ID is not fixed");
  if (!current.ok) {
    const initialized = await room.initialize(project);
    if (!initialized.ok) throw new Error(`Demo project initialization failed: ${initialized.error.code}`);
  }
};

const forwardDemoApi = async (request: Request, env: DemoEnv, password: string): Promise<Response> => {
  // This derived owner credential exists only on the internal Request. The
  // outer policy has already constrained project, route, method, and Origin.
  const internalOwnerSecret = await deriveDemoInternalOwnerSecret(password);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${internalOwnerSecret}`);
  headers.delete("cookie");
  headers.delete("cf-access-jwt-assertion");
  const coreRequest = new Request(request, { headers });
  const coreEnv: Env = {
    ...env,
    PRAXIS_AUTH_MODE: "development_owner",
    PRAXIS_ALLOWED_ORIGIN: new URL(request.url).origin,
    PRAXIS_OWNER_TOKEN: internalOwnerSecret,
    PRAXIS_CAPABILITY_SIGNING_SECRET: internalOwnerSecret,
    PRAXIS_PROVIDER_MODE: "fake",
  };
  return coreWorker.fetch(coreRequest, coreEnv);
};

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const username = env.PRAXIS_DEMO_USERNAME;
    const password = env.PRAXIS_DEMO_PASSWORD;
    if (!username || username.length > 128 || !password || password.length < 32 || password.length > 512) {
      return json({ code: "DEMO_AUTH_NOT_CONFIGURED", message: "Praxis demo authentication is not configured" }, 503);
    }

    const url = new URL(request.url);
    const basicAuthorized = await demoBasicAuthorizationValid(request, username, password);
    const sessionAuthorized = basicAuthorized
      ? false
      : await demoSessionAuthorizationValid(request, username, password);
    const authorized = basicAuthorized || sessionAuthorized;

    if (url.pathname === PRAXIS_DEMO_LOGIN_PATH) {
      if (request.method === "GET") {
        return authorized
          ? new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } })
          : loginPage();
      }
      if (request.method !== "POST") {
        return json({ code: "METHOD_NOT_ALLOWED", message: "The demo login accepts GET and POST" }, 405, { allow: "GET, POST" });
      }
      if (!demoMutationOriginAllowed(request)) {
        return json({ code: "DEMO_ORIGIN_DENIED", message: "Demo login requires the exact application origin" }, 403);
      }
      const credentials = await readDemoLoginCredentials(request);
      if (!credentials.ok) return loginPage(credentials.status, true);
      if (!(await demoCredentialsValid(credentials.username, credentials.password, username, password))) {
        return loginPage(401, true);
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "cache-control": "no-store",
          "set-cookie": await demoSessionCookie(request, username, password),
        },
      });
    }

    if (!authorized) {
      if (request.method === "GET" && url.pathname === "/") return loginPage();
      return unauthorized();
    }

    const reservedPath = url.pathname === "/health"
      || url.pathname === "/api"
      || url.pathname.startsWith("/api/")
      || url.pathname === "/auth"
      || url.pathname.startsWith("/auth/")
      || url.pathname === "/internal"
      || url.pathname.startsWith("/internal/");
    if (!reservedPath) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ code: "METHOD_NOT_ALLOWED", message: "Demo assets are read-only" }, 405, { allow: "GET, HEAD" });
      }
      return forwardDemoAsset(request, env);
    }

    const decision = classifyDemoApiRequest(request);
    if (decision === "not_found") return json({ code: "NOT_FOUND", message: "Route does not exist" }, 404);
    if (decision === "forbidden") {
      return json({ code: "DEMO_FEATURE_DISABLED", message: "This operation is disabled in the no-API demo" }, 403);
    }
    if (!demoMutationOriginAllowed(request)) {
      return json({ code: "DEMO_ORIGIN_DENIED", message: "Demo mutations require the exact application origin" }, 403);
    }
    try {
      if (url.pathname !== "/health") await ensureDemoProject(env);
      return await forwardDemoApi(request, env, password);
    } catch (error) {
      console.error(JSON.stringify({
        message: "Praxis demo request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      return json({ code: "DEMO_INTERNAL_ERROR", message: "The Praxis demo could not complete the request" }, 500);
    }
  },
} satisfies ExportedHandler<DemoEnv>;
