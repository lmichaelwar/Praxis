import { createSeedProject } from "@praxis/project-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import {
  authenticate,
  deniedCommandEntities,
  deniedProjectMutationEntities,
  mintCapability,
  verifyCapability,
} from "./capabilities";

const secret = "a-development-signing-secret-with-more-than-32-characters";
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nonCanonicalSignature = (token: string): string => {
  const parts = token.split(".");
  const signature = parts.at(-1)!;
  const lastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
  parts[parts.length - 1] = `${signature.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
  return parts.join(".");
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Praxis capabilities", () => {
  it("round-trips scoped capability data", async () => {
    const capability = {
      subject: "codex-runner",
      projectId: "project_demo",
      scopes: ["project:read" as const, "command:write" as const],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      deniedEntityIds: ["scene_03"],
    };
    const token = await mintCapability(capability, secret);
    expect(await verifyCapability(token, secret)).toEqual(capability);
    await expect(verifyCapability(nonCanonicalSignature(token), secret)).rejects.toThrow("Malformed");
  });

  it("rejects expiry and the wrong signing secret", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const token = await mintCapability(
      {
        subject: "codex-runner",
        projectId: "project_demo",
        scopes: ["project:read"],
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      },
      secret,
    );
    await expect(verifyCapability(token, `${secret}-wrong`)).rejects.toThrow("signature");
    vi.advanceTimersByTime(2_000);
    await expect(verifyCapability(token, secret)).rejects.toThrow("expired");
  });

  it("enforces project and scope boundaries during authentication", async () => {
    const token = await mintCapability(
      {
        subject: "codex-runner",
        projectId: "project_demo",
        scopes: ["project:read"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      secret,
    );
    const request = new Request("https://praxis.test", { headers: { authorization: `Bearer ${token}` } });
    const env: Env = {
      PROJECT_ROOMS: {} as Env["PROJECT_ROOMS"],
      MEDIA: {} as R2Bucket,
      PRAXIS_OWNER_TOKEN: "owner-token",
      PRAXIS_CAPABILITY_SIGNING_SECRET: secret,
    };

    await expect(authenticate(request, env, { projectId: "project_other", scope: "project:read" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "CAPABILITY_PROJECT_DENIED",
    });
    await expect(authenticate(request, env, { projectId: "project_demo", scope: "command:write" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "CAPABILITY_SCOPE_DENIED",
    });
  });

  it("finds entity IDs nested in project.restore snapshots", () => {
    const snapshot = createSeedProject();
    expect(deniedCommandEntities(
      [{ type: "project.restore", snapshot }],
      ["beat_02", "scene_03", "version_scene_01_v1"],
    )).toEqual(expect.arrayContaining(["beat_02", "scene_03"]));
  });

  it("diffs canonical child, parent, project, stage, and removed entity state", () => {
    const before = createSeedProject();
    const after = structuredClone(before);
    after.script.beats[0]!.title = "Changed title";
    after.timeline.meta.revisionUpdated += 1;
    after.stages.script.revisionUpdated += 1;
    delete after.assets.asset_scene_05;

    expect(deniedProjectMutationEntities(before, after, [
      "project_fax_oracle",
      "beat_01",
      "timeline_main",
      "stage:script",
      "asset_scene_05",
      "scene_02",
    ])).toEqual([
      "asset_scene_05",
      "beat_01",
      "project_fax_oracle",
      "stage:script",
      "timeline_main",
    ]);
  });
});
