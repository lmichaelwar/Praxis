import { describe, expect, it } from "vitest";
import { workflowInstanceId } from "./workflow-instance";

describe("workflow instance IDs", () => {
  it("are deterministic, bounded, and namespaced across job types", async () => {
    const preview = await workflowInstanceId("project_123", "job_123", "render.preview");
    expect(preview).toBe(await workflowInstanceId("project_123", "job_123", "render.preview"));
    expect(preview).toMatch(/^praxis_[a-f0-9]{40}$/u);
    expect(preview).not.toBe(await workflowInstanceId("project_123", "job_123", "image.generate"));
  });
});
