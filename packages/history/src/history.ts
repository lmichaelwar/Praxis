import {
  applyProjectCommand,
  type ApplyProjectCommandSuccess,
  type CommandResult,
  createProjectCommand,
  type ProjectActor,
  type ProjectCommand,
  type ProjectCommandError,
  type ProjectCommandInput,
  ProjectCommandSchema,
  type ProjectOperation,
} from "@praxis/commands";
import {
  ActorKindSchema,
  CheckpointRefSchema,
  IsoDateTimeSchema,
  type ProductionProject,
  ProductionProjectSchema,
  StableIdSchema,
} from "@praxis/project-schema";
import { z } from "zod";

export const HistoryEntrySchema = z
  .object({
    entryId: StableIdSchema,
    projectId: StableIdSchema,
    revisionBefore: z.number().int().nonnegative(),
    revisionAfter: z.number().int().nonnegative(),
    committedAt: IsoDateTimeSchema,
    command: ProjectCommandSchema,
    inverseCommand: ProjectCommandSchema,
    affectedEntityIds: z.array(StableIdSchema.or(z.string().startsWith("stage:"))),
    invalidatedEntityIds: z.array(StableIdSchema.or(z.string().startsWith("stage:"))),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.revisionAfter !== entry.revisionBefore + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revisionAfter"],
        message: "A committed history entry must advance exactly one project revision",
      });
    }
    if (entry.command.projectId !== entry.projectId || entry.inverseCommand.projectId !== entry.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "History commands must target the entry project",
      });
    }
  });
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const ProjectHistorySchema = z
  .object({
    projectId: StableIdSchema,
    entries: z.array(HistoryEntrySchema).default([]),
    redoStack: z.array(HistoryEntrySchema).default([]),
  })
  .strict()
  .superRefine((history, context) => {
    for (const [index, entry] of [...history.entries, ...history.redoStack].entries()) {
      if (entry.projectId !== history.projectId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index < history.entries.length ? "entries" : "redoStack", index, "projectId"],
          message: "Every history entry must belong to the history project",
        });
      }
    }
  });
export type ProjectHistory = z.infer<typeof ProjectHistorySchema>;

export const ProjectCheckpointSchema = z
  .object({
    id: StableIdSchema,
    label: z.string().min(1).max(160),
    projectId: StableIdSchema,
    revision: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    createdBy: ActorKindSchema,
    reason: z.string().max(1_000).optional(),
    snapshot: ProductionProjectSchema,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.snapshot.projectId !== checkpoint.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "projectId"],
        message: "Checkpoint snapshot belongs to a different project",
      });
    }
    if (checkpoint.snapshot.revision !== checkpoint.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "revision"],
        message: "Checkpoint revision must match its snapshot revision",
      });
    }
  });
export type ProjectCheckpoint = z.infer<typeof ProjectCheckpointSchema>;

export interface HistoryError {
  code: "HISTORY_EMPTY" | "HISTORY_PROJECT_MISMATCH" | "INVALID_HISTORY";
  summary: string;
}

export interface HistorySuccess {
  ok: true;
  project: ProductionProject;
  history: ProjectHistory;
  application: ApplyProjectCommandSuccess;
  entry?: HistoryEntry;
}

export interface HistoryFailure {
  ok: false;
  project: ProductionProject;
  history: ProjectHistory;
  error: ProjectCommandError | HistoryError;
}

export type HistoryResult = HistorySuccess | HistoryFailure;

export interface CheckpointOptions {
  id?: string;
  label: string;
  actor?: ProjectActor;
  reason?: string;
  createdAt?: string;
}

let historyCounter = 0;

const nextId = (prefix: string) => {
  historyCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${historyCounter.toString(36)}`;
};

const defaultActor: ProjectActor = {
  kind: "director",
  sessionId: "session_history_director",
};

const historyMismatch = (
  project: ProductionProject,
  history: ProjectHistory,
): HistoryFailure => ({
  ok: false,
  project,
  history,
  error: {
    code: "HISTORY_PROJECT_MISMATCH",
    summary: `History for ${history.projectId} cannot be applied to ${project.projectId}`,
  },
});

export const createProjectHistory = (projectId: string): ProjectHistory =>
  ProjectHistorySchema.parse({ projectId, entries: [], redoStack: [] });

const historyEntryFromApplication = (
  projectBefore: ProductionProject,
  command: ProjectCommand,
  application: ApplyProjectCommandSuccess,
  entryId = nextId("history"),
): HistoryEntry =>
  HistoryEntrySchema.parse({
    entryId,
    projectId: projectBefore.projectId,
    revisionBefore: projectBefore.revision,
    revisionAfter: application.project.revision,
    committedAt: application.project.metadata.updatedAt,
    command,
    inverseCommand: application.inverseCommand,
    affectedEntityIds: application.result.affectedEntityIds,
    invalidatedEntityIds: application.result.invalidatedEntityIds,
  });

/** Applies and appends one committed command. Failed or dry-run commands never enter history. */
export const applyCommandWithHistory = (
  project: ProductionProject,
  history: ProjectHistory,
  commandInput: ProjectCommandInput | unknown,
): HistoryResult => {
  const parsedHistory = ProjectHistorySchema.safeParse(history);
  if (!parsedHistory.success) {
    return {
      ok: false,
      project,
      history,
      error: { code: "INVALID_HISTORY", summary: parsedHistory.error.message },
    };
  }
  if (history.projectId !== project.projectId) return historyMismatch(project, history);

  const application = applyProjectCommand(project, commandInput);
  if (!application.ok) return { ok: false, project, history, error: application.error };
  if (application.result.dryRun) {
    return { ok: true, project, history, application };
  }

  const command = ProjectCommandSchema.parse(commandInput);
  const entry = historyEntryFromApplication(project, command, application);
  const nextHistory = ProjectHistorySchema.parse({
    projectId: history.projectId,
    entries: [...history.entries, entry],
    // A new branch invalidates redo, exactly as in a conventional editor.
    redoStack: [],
  });
  return { ok: true, project: application.project, history: nextHistory, application, entry };
};

const rebasedCommand = (
  command: ProjectCommand,
  project: ProductionProject,
  actor: ProjectActor,
  suffix: "undo" | "redo",
): ProjectCommand =>
  ProjectCommandSchema.parse({
    ...command,
    commandId: `${command.commandId.slice(0, 116)}:${suffix}:${project.revision}`,
    idempotencyKey: `${command.idempotencyKey.slice(0, 116)}:${suffix}:${project.revision}`,
    baseRevision: project.revision,
    actor,
    createdAt: new Date().toISOString(),
    dryRun: false,
  });

/** Applies the stored inverse snapshot as a new revision and moves the entry to the redo stack. */
export const undoLastCommand = (
  project: ProductionProject,
  history: ProjectHistory,
  actor: ProjectActor = defaultActor,
): HistoryResult => {
  if (history.projectId !== project.projectId) return historyMismatch(project, history);
  const entry = history.entries.at(-1);
  if (!entry) {
    return {
      ok: false,
      project,
      history,
      error: { code: "HISTORY_EMPTY", summary: "There is no committed command to undo" },
    };
  }

  if (entry.revisionAfter !== project.revision) {
    const staleInverse = ProjectCommandSchema.parse({
      ...entry.inverseCommand,
      baseRevision: entry.revisionAfter,
      actor,
      createdAt: new Date().toISOString(),
    });
    const conflict = applyProjectCommand(project, staleInverse);
    if (!conflict.ok) return { ok: false, project, history, error: conflict.error };
  }

  const inverse = rebasedCommand(entry.inverseCommand, project, actor, "undo");
  const application = applyProjectCommand(project, inverse);
  if (!application.ok) return { ok: false, project, history, error: application.error };

  const nextHistory = ProjectHistorySchema.parse({
    projectId: history.projectId,
    entries: history.entries.slice(0, -1),
    redoStack: [...history.redoStack, entry],
  });
  return { ok: true, project: application.project, history: nextHistory, application };
};

/** Reapplies the original semantic operations at the current revision. */
export const redoLastCommand = (
  project: ProductionProject,
  history: ProjectHistory,
  actor: ProjectActor = defaultActor,
): HistoryResult => {
  if (history.projectId !== project.projectId) return historyMismatch(project, history);
  const entry = history.redoStack.at(-1);
  if (!entry) {
    return {
      ok: false,
      project,
      history,
      error: { code: "HISTORY_EMPTY", summary: "There is no undone command to redo" },
    };
  }

  const command = rebasedCommand(entry.command, project, actor, "redo");
  const application = applyProjectCommand(project, command);
  if (!application.ok) return { ok: false, project, history, error: application.error };
  const replayedEntry = historyEntryFromApplication(project, command, application, entry.entryId);
  const nextHistory = ProjectHistorySchema.parse({
    projectId: history.projectId,
    entries: [...history.entries, replayedEntry],
    redoStack: history.redoStack.slice(0, -1),
  });
  return {
    ok: true,
    project: application.project,
    history: nextHistory,
    application,
    entry: replayedEntry,
  };
};

export const createCheckpoint = (
  project: ProductionProject,
  options: CheckpointOptions,
): ProjectCheckpoint => {
  const actor = options.actor ?? defaultActor;
  return ProjectCheckpointSchema.parse({
    id: options.id ?? nextId("checkpoint"),
    label: options.label,
    projectId: project.projectId,
    revision: project.revision,
    createdAt: options.createdAt ?? new Date().toISOString(),
    createdBy: actor.kind,
    reason: options.reason,
    snapshot: structuredClone(project),
  });
};

export const checkpointRef = (checkpoint: ProjectCheckpoint) =>
  CheckpointRefSchema.parse({
    id: checkpoint.id,
    label: checkpoint.label,
    revision: checkpoint.revision,
    createdAt: checkpoint.createdAt,
    createdBy: checkpoint.createdBy,
    reason: checkpoint.reason,
  });

export interface CheckpointCommandOptions {
  actor?: ProjectActor;
  commandId?: string;
  idempotencyKey?: string;
  reason?: string;
}

/** Produces the normal command needed to expose a durable checkpoint in the project ledger. */
export const createCheckpointCommand = (
  project: ProductionProject,
  checkpoint: ProjectCheckpoint,
  options: CheckpointCommandOptions = {},
): ProjectCommand =>
  createProjectCommand(
    project.projectId,
    project.revision,
    [{ type: "checkpoint.add", checkpoint: checkpointRef(checkpoint) }],
    {
      actor: options.actor ?? defaultActor,
      commandId: options.commandId,
      idempotencyKey: options.idempotencyKey,
      reason: options.reason ?? `Create checkpoint: ${checkpoint.label}`,
    },
  );

export interface RestoreCheckpointOptions extends CheckpointCommandOptions {
  createdAt?: string;
}

export const createRestoreCheckpointCommand = (
  project: ProductionProject,
  checkpoint: ProjectCheckpoint,
  options: RestoreCheckpointOptions = {},
): ProjectCommand => {
  if (checkpoint.projectId !== project.projectId) {
    throw new Error(`Checkpoint ${checkpoint.id} belongs to ${checkpoint.projectId}`);
  }
  return createProjectCommand(
    project.projectId,
    project.revision,
    [
      {
        type: "project.restore",
        snapshot: structuredClone(checkpoint.snapshot),
        checkpointId: checkpoint.id,
      },
    ],
    {
      actor: options.actor ?? defaultActor,
      commandId: options.commandId,
      idempotencyKey: options.idempotencyKey,
      reason: options.reason ?? `Restore checkpoint: ${checkpoint.label}`,
      createdAt: options.createdAt,
    },
  );
};

export const restoreCheckpoint = (
  project: ProductionProject,
  checkpoint: ProjectCheckpoint,
  options: RestoreCheckpointOptions = {},
) => applyProjectCommand(project, createRestoreCheckpointCommand(project, checkpoint, options));

export interface ResetProjectOptions extends RestoreCheckpointOptions {
  label?: string;
}

/** Reset is checkpoint restore with an explicit target snapshot; it never mutates the supplied seed. */
export const resetProject = (
  project: ProductionProject,
  resetSnapshot: ProductionProject,
  options: ResetProjectOptions = {},
) => {
  const checkpoint = createCheckpoint(resetSnapshot, {
    id: `checkpoint_reset_${resetSnapshot.revision}`,
    label: options.label ?? "Project reset point",
    actor: options.actor ?? defaultActor,
    reason: options.reason ?? "Reset project to a known snapshot",
    createdAt: options.createdAt,
  });
  return restoreCheckpoint(project, checkpoint, options);
};

/** Useful for append-only persistence adapters. */
export const commandResultFromHistoryEntry = (entry: HistoryEntry): CommandResult => ({
  revision: entry.revisionAfter,
  appliedOperationIds: entry.command.operations.map(
    (operation: ProjectOperation, index: number) => operation.operationId ?? `${entry.command.commandId}:${index}`,
  ),
  affectedEntityIds: [...entry.affectedEntityIds],
  invalidatedEntityIds: [...entry.invalidatedEntityIds],
  dryRun: false,
});

export const createHistory = createProjectHistory;
export const applyWithHistory = applyCommandWithHistory;
export const undo = undoLastCommand;
export const redo = redoLastCommand;
export const createProjectCheckpoint = createCheckpoint;
