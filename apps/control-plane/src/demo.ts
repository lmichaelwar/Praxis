import { createSeedProject } from "@praxis/project-schema";
import coreWorker from "./index";
import type { Env } from "./env";
import { ProjectRoom, type ProjectRoomClient } from "./project-room";
import {
  classifyDemoApiRequest,
  demoBasicAuthorizationValid,
  demoMutationOriginAllowed,
  deriveDemoInternalOwnerSecret,
  PRAXIS_DEMO_PROJECT_ID,
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
  { "www-authenticate": 'Basic realm="Praxis Demo", charset="UTF-8"' },
);

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
    if (!username || !password || password.length < 32) {
      return json({ code: "DEMO_AUTH_NOT_CONFIGURED", message: "Praxis demo authentication is not configured" }, 503);
    }
    if (!(await demoBasicAuthorizationValid(request, username, password))) return unauthorized();

    const url = new URL(request.url);
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
      return env.ASSETS.fetch(request);
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
