import type { Env } from "./env";

export const requireMediaBinding = (env: Pick<Env, "MEDIA">): R2Bucket => {
  if (!env.MEDIA) throw new Error("MEDIA binding is not configured");
  return env.MEDIA;
};
