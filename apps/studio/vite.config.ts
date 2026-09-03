import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appDirectory, "../..");

export default defineConfig(({ mode }) => {
  // These values are consumed only by Vite's Node process. They are never
  // exposed through import.meta.env or a VITE_-prefixed browser variable.
  const environment = loadEnv(mode, repositoryRoot, "");
  const ownerToken = process.env.PRAXIS_OWNER_TOKEN ?? environment.PRAXIS_OWNER_TOKEN;
  const configuredControlPlane =
    process.env.PRAXIS_PUBLIC_API_BASE_URL ??
    environment.PRAXIS_PUBLIC_API_BASE_URL ??
    "http://127.0.0.1:8787";
  const controlPlaneOrigin = new URL(configuredControlPlane).origin;

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": {
          target: controlPlaneOrigin,
          changeOrigin: true,
          headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : undefined,
        },
      },
    },
  };
});
