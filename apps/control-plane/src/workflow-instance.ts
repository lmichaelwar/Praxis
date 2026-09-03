const encoder = new TextEncoder();

/**
 * Cloudflare Workflow instance IDs are an infrastructure namespace, not a
 * canonical Praxis entity namespace. Hashing keeps long user-controlled IDs
 * bounded while preserving deterministic restart attachment.
 */
export const workflowInstanceId = async (
  projectId: string,
  jobId: string,
  jobType: string,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`praxis-workflow-v1\0${projectId}\0${jobId}\0${jobType}`)),
  );
  const suffix = [...digest].slice(0, 20).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `praxis_${suffix}`;
};
