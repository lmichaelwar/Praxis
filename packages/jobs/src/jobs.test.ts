import { describe, expect, it } from "vitest";
import { estimateJobCostUsd } from "./pricing";
import { JobCreateRequestSchema, ProjectEventSchema } from "./schema";

describe("job contracts", () => {
  it("keeps fake media zero-cost and estimates configured live media", () => {
    const fake = JobCreateRequestSchema.parse({
      jobType: "image.generate",
      idempotencyKey: "image-request-0001",
      baseRevision: 2,
      targetEntityIds: ["scene_01"],
      request: {
        assetId: "asset_scene_01",
        sceneId: "scene_01",
        prompt: "An institutional corridor",
      },
    });
    expect(estimateJobCostUsd(fake)).toBe(0);

    const live = JobCreateRequestSchema.parse({
      ...fake,
      idempotencyKey: "image-request-0002",
      request: { ...fake.request, provider: "openai", quality: "low" },
    });
    expect(estimateJobCostUsd(live)).toBe(0.013);
  });

  it("requires monotonic positive event sequences", () => {
    expect(() =>
      ProjectEventSchema.parse({
        sequence: 0,
        projectId: "project_demo",
        type: "job.updated",
        createdAt: "2026-08-26T12:00:00.000Z",
        jobId: "job_demo",
        status: "queued",
      }),
    ).toThrow();
  });
});
