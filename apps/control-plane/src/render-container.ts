import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/**
 * Cloudflare Container adapter for the independently built render-worker image.
 * The renderer receives only a per-job bearer token and trusted Praxis API URL.
 */
export class RenderContainer extends Container<Env> {
  defaultPort = 8790;
  sleepAfter = "10m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const secret = env.PRAXIS_RENDER_AUTH_SECRET ?? env.PRAXIS_RENDER_WORKER_TOKEN;
    this.envVars = {
      PRAXIS_RENDER_PORT: "8790",
      PRAXIS_RENDERER_VERSION: "praxis-ffmpeg-1",
      ...(secret ? { PRAXIS_RENDER_AUTH_SECRET: secret } : {}),
      ...(env.PRAXIS_RENDER_RESULT_SIGNING_SECRET ? { PRAXIS_RENDER_RESULT_SIGNING_SECRET: env.PRAXIS_RENDER_RESULT_SIGNING_SECRET } : {}),
      ...(env.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID ? { PRAXIS_RENDER_RESULT_SIGNING_KEY_ID: env.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID } : {}),
    };
  }
}
