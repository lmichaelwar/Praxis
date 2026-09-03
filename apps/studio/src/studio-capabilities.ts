export interface StudioCapabilities {
  readonly mode: "submission-demo" | "full";
  readonly mediaActions: boolean;
  readonly delegationActions: boolean;
  readonly source: "environment" | "safe-default";
}

interface StudioCapabilityEnvironment {
  readonly VITE_PRAXIS_SUBMISSION_DEMO?: string;
}

/**
 * Provider-backed actions fail closed for public builds. A full Studio build
 * must opt out explicitly; misspelled or missing values stay in demo mode.
 */
export function resolveStudioCapabilities(
  environment: StudioCapabilityEnvironment = import.meta.env,
): StudioCapabilities {
  const configured = environment.VITE_PRAXIS_SUBMISSION_DEMO?.trim().toLowerCase();
  const submissionDemo = configured !== "false";

  return {
    mode: submissionDemo ? "submission-demo" : "full",
    mediaActions: !submissionDemo,
    delegationActions: !submissionDemo,
    source: configured === undefined ? "safe-default" : "environment",
  };
}

export const STUDIO_CAPABILITIES = resolveStudioCapabilities();
