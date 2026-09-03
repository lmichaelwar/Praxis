import {
  IsoDateTimeSchema,
  StableIdSchema,
  StageNameSchema,
} from "@praxis/project-schema";
import { z } from "zod";

export const CAPABILITY_SCOPES = [
  "project:read",
  "command:write",
  "job:create",
  "job:read",
  "job:cancel",
  "asset:read",
  "agent:read",
  "agent:write",
  "agent:dispatch",
] as const;

export const CapabilityScopeSchema = z.enum(CAPABILITY_SCOPES);
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

export const AGENT_RUN_ROLES = ["producer-editor", "reviewer"] as const;
export const AgentRunRoleSchema = z.enum(AGENT_RUN_ROLES);
export type AgentRunRole = z.infer<typeof AgentRunRoleSchema>;

export const AGENT_RUN_MODES = ["propose", "act"] as const;
export const AgentRunModeSchema = z.enum(AGENT_RUN_MODES);
export type AgentRunMode = z.infer<typeof AgentRunModeSchema>;

export const AGENT_RUN_STAGES = StageNameSchema.options;
export const AgentRunStageSchema = StageNameSchema;
export type AgentRunStage = z.infer<typeof AgentRunStageSchema>;

const uniqueStages = z
  .array(AgentRunStageSchema)
  .min(1)
  .max(AGENT_RUN_STAGES.length)
  .superRefine((stages, context) => {
    if (new Set(stages).size !== stages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AgentRun stages must be unique",
      });
    }
  });

export const AGENT_RUN_STATUSES = [
  "created",
  "dispatching",
  "claimed",
  "working",
  "waiting_on_jobs",
  "completed",
  "failed",
  "cancelled",
  "dispatch_unknown",
] as const;

export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a URL-safe idempotency key");

const uniqueScopes = z
  .array(CapabilityScopeSchema)
  .min(1)
  .max(CAPABILITY_SCOPES.length)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability scopes must be unique",
      });
    }
  });

const uniqueEntityIds = z
  .array(StableIdSchema)
  .max(256)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Denied entity IDs must be unique",
      });
    }
  });

const ErrorCodeSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Use an uppercase machine-readable error code");

const ErrorMessageSchema = z.string().min(1).max(2_000);
const CompletionSummarySchema = z.string().min(1).max(4_000);
const CodexTaskIdSchema = z.string().min(1).max(256);
const CodexTaskUrlSchema = z.string().url().max(2_048);

const timestamp = (value: string) => Date.parse(value);

export const AgentRunSchema = z
  .object({
    id: StableIdSchema,
    projectId: StableIdSchema,
    checkpointId: StableIdSchema,
    baseRevision: z.number().int().nonnegative(),
    role: AgentRunRoleSchema,
    // Defaults let legacy durable rows hydrate while keeping the canonical output type required.
    stages: uniqueStages.default([...AGENT_RUN_STAGES]),
    mode: AgentRunModeSchema.default("act"),
    status: AgentRunStatusSchema,
    scopes: uniqueScopes,
    deniedEntityIds: uniqueEntityIds.default([]),
    maxSpendUsd: z.number().nonnegative().finite().max(10_000),
    claimExpiresAt: IsoDateTimeSchema,
    leaseExpiresAt: IsoDateTimeSchema.optional(),
    codexTaskId: CodexTaskIdSchema.optional(),
    codexTaskUrl: CodexTaskUrlSchema.optional(),
    lastHeartbeatAt: IsoDateTimeSchema.optional(),
    completionSummary: CompletionSummarySchema.optional(),
    errorCode: ErrorCodeSchema.optional(),
    errorMessage: ErrorMessageSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((run, context) => {
    const createdAt = timestamp(run.createdAt);
    const orderedTimestamp = (
      key: "claimExpiresAt" | "leaseExpiresAt" | "lastHeartbeatAt" | "updatedAt",
      value: string | undefined,
    ) => {
      if (value !== undefined && timestamp(value) < createdAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} cannot precede createdAt`,
        });
      }
    };

    orderedTimestamp("claimExpiresAt", run.claimExpiresAt);
    orderedTimestamp("leaseExpiresAt", run.leaseExpiresAt);
    orderedTimestamp("lastHeartbeatAt", run.lastHeartbeatAt);
    orderedTimestamp("updatedAt", run.updatedAt);

    if (
      run.lastHeartbeatAt !== undefined &&
      run.leaseExpiresAt !== undefined &&
      timestamp(run.leaseExpiresAt) < timestamp(run.lastHeartbeatAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leaseExpiresAt"],
        message: "leaseExpiresAt cannot precede lastHeartbeatAt",
      });
    }

    if ((run.status === "claimed" || run.status === "working") && !run.leaseExpiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leaseExpiresAt"],
        message: `${run.status} AgentRuns require leaseExpiresAt`,
      });
    }
  });

export type AgentRun = z.infer<typeof AgentRunSchema>;

export const CreateAgentRunInputSchema = z
  .object({
    runId: StableIdSchema.optional(),
    checkpointId: StableIdSchema.optional(),
    checkpointCommandId: StableIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
    baseRevision: z.number().int().nonnegative(),
    role: AgentRunRoleSchema,
    stages: uniqueStages.default([...AGENT_RUN_STAGES]),
    mode: AgentRunModeSchema.default("act"),
    scopes: uniqueScopes,
    deniedEntityIds: uniqueEntityIds.default([]),
    maxSpendUsd: z.number().nonnegative().finite().max(10_000),
    claimTicketTtlSeconds: z.number().int().min(60).max(1_800).default(600),
    checkpointLabel: z.string().min(1).max(160).default("Before delegated production"),
    checkpointReason: z.string().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.role === "reviewer" && run.mode !== "propose") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Reviewer AgentRuns must use propose mode",
      });
    }
  });

export type CreateAgentRunInput = z.infer<typeof CreateAgentRunInputSchema>;
export type CreateAgentRunRequest = z.input<typeof CreateAgentRunInputSchema>;

export const AgentRunClaimRequestSchema = z
  .object({
    ticket: z.string().min(32).max(16_384),
  })
  .strict();

export type AgentRunClaimRequest = z.infer<typeof AgentRunClaimRequestSchema>;
export const ClaimAgentRunInputSchema = AgentRunClaimRequestSchema;
export type ClaimAgentRunInput = AgentRunClaimRequest;

export const AgentClaimTicketClaimsSchema = z
  .object({
    version: z.literal(1),
    ticketId: StableIdSchema,
    projectId: StableIdSchema,
    runId: StableIdSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export type AgentClaimTicketClaims = z.infer<typeof AgentClaimTicketClaimsSchema>;

const DispatchMutationBaseSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
});

export const AgentRunDispatchInputSchema = z.discriminatedUnion("action", [
  DispatchMutationBaseSchema.extend({
    action: z.literal("begin"),
  }).strict(),
  DispatchMutationBaseSchema.extend({
    action: z.literal("record_task"),
    codexTaskId: CodexTaskIdSchema,
    codexTaskUrl: CodexTaskUrlSchema.optional(),
  }).strict(),
  DispatchMutationBaseSchema.extend({
    action: z.literal("mark_unknown"),
    errorCode: ErrorCodeSchema.optional(),
    errorMessage: ErrorMessageSchema.optional(),
  }).strict(),
  DispatchMutationBaseSchema.extend({
    action: z.literal("mark_failed"),
    errorCode: ErrorCodeSchema,
    errorMessage: ErrorMessageSchema,
  }).strict(),
]);

export type AgentRunDispatchInput = z.infer<typeof AgentRunDispatchInputSchema>;
export const DispatchAgentRunInputSchema = AgentRunDispatchInputSchema;
export type DispatchAgentRunInput = AgentRunDispatchInput;

export const AgentRunHeartbeatInputSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export type AgentRunHeartbeatInput = z.infer<typeof AgentRunHeartbeatInputSchema>;
export const HeartbeatAgentRunInputSchema = AgentRunHeartbeatInputSchema;
export type HeartbeatAgentRunInput = AgentRunHeartbeatInput;

export const AgentRunFinishInputSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    status: z.enum(["waiting_on_jobs", "completed", "failed"]),
    completionSummary: CompletionSummarySchema.optional(),
    errorCode: ErrorCodeSchema.optional(),
    errorMessage: ErrorMessageSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.status === "failed") return;
    if (input.errorCode !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "errorCode is only valid when finishing as failed",
      });
    }
    if (input.errorMessage !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "errorMessage is only valid when finishing as failed",
      });
    }
  });

export type AgentRunFinishInput = z.infer<typeof AgentRunFinishInputSchema>;
export const FinishAgentRunInputSchema = AgentRunFinishInputSchema;
export type FinishAgentRunInput = AgentRunFinishInput;

export const AgentRunTransitionInputSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    expectedStatuses: z.array(AgentRunStatusSchema).min(1).max(AGENT_RUN_STATUSES.length),
    status: AgentRunStatusSchema,
    leaseExpiresAt: IsoDateTimeSchema.optional(),
    codexTaskId: CodexTaskIdSchema.optional(),
    codexTaskUrl: CodexTaskUrlSchema.optional(),
    lastHeartbeatAt: IsoDateTimeSchema.optional(),
    completionSummary: CompletionSummarySchema.optional(),
    errorCode: ErrorCodeSchema.optional(),
    errorMessage: ErrorMessageSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.expectedStatuses).size !== input.expectedStatuses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedStatuses"],
        message: "Expected AgentRun statuses must be unique",
      });
    }
  });

export type AgentRunTransitionInput = z.infer<typeof AgentRunTransitionInputSchema>;
