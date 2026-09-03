import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  RenderUploadGrantSchema,
  handleLocalRenderUpload,
  mintRenderUploadGrant,
  verifyRenderUploadGrant,
} from "./render-upload";

const secret = "render-upload-test-secret-".repeat(3);
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nonCanonicalSignature = (token: string): string => {
  const parts = token.split(".");
  const signature = parts.at(-1)!;
  const lastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
  parts[parts.length - 1] = `${signature.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
  return parts.join(".");
};

describe("render result upload grants", () => {
  it("mints a dedicated application/json grant for the immutable sidecar", async () => {
    const grant = {
      version: 1 as const,
      projectId: "project_test",
      jobId: "job_test",
      part: "result" as const,
      objectKey: "projects/project_test/render-results/7/render_test.json",
      mimeType: "application/json" as const,
      expiresAt: expiresAt(),
    };
    const token = await mintRenderUploadGrant(grant, secret);

    await expect(verifyRenderUploadGrant(token, secret)).resolves.toEqual(grant);
    await expect(verifyRenderUploadGrant(nonCanonicalSignature(token), secret)).rejects.toThrow("Malformed");
    expect(RenderUploadGrantSchema.safeParse({ ...grant, mimeType: "image/jpeg" }).success).toBe(false);
  });

  it("enforces the 64 KiB result-sidecar upload limit", async () => {
    const token = await mintRenderUploadGrant({
      version: 1,
      projectId: "project_test",
      jobId: "job_test",
      part: "result",
      objectKey: "projects/project_test/render-results/7/render_test.json",
      mimeType: "application/json",
      expiresAt: expiresAt(),
    }, secret);
    const response = await handleLocalRenderUpload(new Request(
      `http://127.0.0.1/internal/render-outputs?grant=${encodeURIComponent(token)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
          "if-none-match": "*",
          "x-praxis-sha256": "a".repeat(64),
        },
        body: "{}",
      },
    ), {
      PRAXIS_CAPABILITY_SIGNING_SECRET: secret,
    } as Env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_RENDER_CONTENT_LENGTH" });
  });
});
