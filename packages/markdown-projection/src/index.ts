/**
 * The Markdown view is a projection of canonical project state. It deliberately
 * produces beat-level update intents instead of a replacement script document.
 */

export const SCRIPT_MARKDOWN_FPS = 30 as const;

export const SCRIPT_BEAT_STATUSES = [
  "draft",
  "approved",
  "stale",
  "failed",
  "rejected",
] as const;
export type ScriptBeatStatus = (typeof SCRIPT_BEAT_STATUSES)[number];

export interface ProjectableBeatMeta {
  readonly id: string;
  readonly status: ScriptBeatStatus;
}

/**
 * The smallest structural slice of a Praxis ScriptBeat needed by this package.
 * Domain ScriptBeat values can be passed directly without importing that package.
 */
export interface ProjectableScriptBeat {
  readonly meta: ProjectableBeatMeta;
  readonly title: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly narration: string;
  readonly visualIntent: string;
}

export interface ParsedScriptBeat {
  readonly id: string;
  readonly title: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly narration: string;
  readonly visualIntent: string;
  readonly status: ScriptBeatStatus;
  /** One-based source line for the beat marker. */
  readonly line: number;
}

export interface ParsedBeatPatch {
  title?: string;
  startFrame?: number;
  durationFrames?: number;
  narration?: string;
  visualIntent?: string;
  status?: ScriptBeatStatus;
}

/** A domain-neutral semantic update detected from an edited projection. */
export interface ParsedBeatUpdate {
  readonly beatId: string;
  readonly changes: ParsedBeatPatch;
}

/** The default adapter output, compatible with Praxis's command operation. */
export interface ScriptUpdateBeatOperation {
  readonly type: "script.updateBeat";
  readonly beatId: string;
  readonly patch: ParsedBeatPatch;
}

export type MarkdownProjectionIssueCode =
  | "MALFORMED_BEAT_MARKER"
  | "MISSING_BEAT_ID"
  | "DUPLICATE_BEAT_ID"
  | "UNKNOWN_BEAT_ID"
  | "DUPLICATE_SOURCE_ID"
  | "INVALID_SOURCE_BEAT"
  | "MISSING_BEAT_HEADING"
  | "MALFORMED_BEAT_HEADING"
  | "MISSING_BEAT_TITLE"
  | "INVALID_TIMECODE"
  | "INVALID_FRAME_RANGE"
  | "INVALID_STATUS"
  | "MISSING_FIELD"
  | "DUPLICATE_FIELD"
  | "UNEXPECTED_CONTENT";

export type MarkdownProjectionField =
  | "title"
  | "timing"
  | "narration"
  | "visualIntent"
  | "status";

export interface MarkdownProjectionIssue {
  readonly code: MarkdownProjectionIssueCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** One-based source line, when the issue originates in Markdown. */
  readonly line?: number;
  readonly beatId?: string;
  readonly field?: MarkdownProjectionField;
}

export interface ParseScriptMarkdownResult {
  readonly ok: boolean;
  /** Only beats whose structured block parsed without errors. */
  readonly beats: readonly ParsedScriptBeat[];
  readonly issues: readonly MarkdownProjectionIssue[];
}

export interface ParseEditedScriptMarkdownResult
  extends ParseScriptMarkdownResult {
  /**
   * Minimal changes for valid, known, uniquely identified beats. Missing beats
   * never become delete operations.
   */
  readonly updates: readonly ParsedBeatUpdate[];
}

export interface ParseEditedScriptMarkdownOptions {
  /** Report source beats absent from the projection. Defaults to true. */
  readonly requireAllBeats?: boolean;
  /** Reject IDs that do not exist in the source collection. Defaults to true. */
  readonly rejectUnknownBeats?: boolean;
}

export class MarkdownProjectionInputError extends Error {
  readonly issues: readonly MarkdownProjectionIssue[];

  constructor(issues: readonly MarkdownProjectionIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "MarkdownProjectionInputError";
    this.issues = issues;
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VALID_MARKER_PATTERN =
  /^\s*<!--\s*beat\s*:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*-->\s*$/i;
const MARKER_CANDIDATE_PATTERN = /^\s*<!--\s*beat\b/i;
const LEVEL_TWO_HEADING_PATTERN = /^\s*##(?!#)\s+/;
const TIMECODE_TOKEN = "[0-9]+(?::[0-9]{2}){1,3}";
const BEAT_HEADING_PATTERN = new RegExp(
  `^\\s*##(?!#)\\s+(${TIMECODE_TOKEN})\\s*(?:–|—|->|-)\\s*(${TIMECODE_TOKEN})(?:\\s+(?:—|–|-)\\s+(.+?))?\\s*$`,
);

type ParsedFieldName = "narration" | "visualIntent" | "status";

const FIELD_LABELS: Record<ParsedFieldName, string> = {
  narration: "Narration",
  visualIntent: "Visual intent",
  status: "Status",
};

const FIELD_LINE_PATTERN =
  /^\s*\*\*(Narration|Visual\s+intent|Status):\*\*(?:[ \t]?(.*))?$/i;

interface MarkerCandidate {
  readonly index: number;
  readonly line: number;
  readonly raw: string;
  readonly id?: string;
}

interface InternalParseResult extends ParseScriptMarkdownResult {
  readonly idCounts: ReadonlyMap<string, number>;
}

interface ParsedHeading {
  readonly title: string;
  readonly startFrame: number;
  readonly durationFrames: number;
}

/** Convert a non-negative frame position to HH:MM:SS:FF at fixed 30 fps. */
export function framesToTimecode(frame: number): string {
  assertFrame(frame, "frame");

  const frames = frame % SCRIPT_MARKDOWN_FPS;
  const totalSeconds = Math.floor(frame / SCRIPT_MARKDOWN_FPS);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return [hours, minutes, seconds, frames]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * Parse HH:MM:SS:FF (frame exact), HH:MM:SS, or MM:SS at fixed 30 fps.
 * The latter two forms represent whole-second positions.
 */
export function timecodeToFrames(timecode: string): number {
  const parsed = tryTimecodeToFrames(timecode);
  if (parsed === undefined) {
    throw new RangeError(
      `Invalid 30 fps timecode ${JSON.stringify(timecode)}. Expected HH:MM:SS:FF, HH:MM:SS, or MM:SS.`,
    );
  }
  return parsed;
}

/**
 * Project canonical beats to the director-readable Markdown view.
 * The returned document ends with a newline for stable file output.
 */
export function renderScriptMarkdown(
  beats: readonly ProjectableScriptBeat[],
): string {
  const issues = validateSourceBeats(beats);
  if (issues.length > 0) {
    throw new MarkdownProjectionInputError(issues);
  }

  if (beats.length === 0) {
    return "";
  }

  const blocks = beats.map((beat) => {
    const id = beat.meta.id;
    const start = framesToTimecode(beat.startFrame);
    const end = framesToTimecode(beat.startFrame + beat.durationFrames);
    const title = normalizeScalar(beat.title);
    const narration = renderField("Narration", beat.narration);
    const visualIntent = renderField("Visual intent", beat.visualIntent);
    const status = renderField("Status", formatStatus(beat.meta.status));

    return [
      `<!-- beat:${id} -->`,
      `## ${start}–${end} — ${title}`,
      "",
      narration,
      "",
      visualIntent,
      "",
      status,
    ].join("\n");
  });

  return `${blocks.join("\n\n")}\n`;
}

/** Parse structured beat blocks without comparing them to project state. */
export function parseScriptMarkdown(
  markdown: string,
): ParseScriptMarkdownResult {
  const { idCounts: _idCounts, ...result } = parseMarkdownInternal(markdown);
  return result;
}

/**
 * Parse an edited projection and compute only the semantic beat fields that
 * changed relative to the canonical source collection.
 */
export function parseEditedScriptMarkdown(
  markdown: string,
  sourceBeats: readonly ProjectableScriptBeat[],
  options: ParseEditedScriptMarkdownOptions = {},
): ParseEditedScriptMarkdownResult {
  const parsed = parseMarkdownInternal(markdown);
  const issues = [...parsed.issues];
  const sourceById = new Map<string, ProjectableScriptBeat>();
  const invalidSourceIds = new Set<string>();

  for (const issue of validateSourceBeats(sourceBeats)) {
    issues.push(issue);
    if (issue.beatId) {
      invalidSourceIds.add(issue.beatId);
    }
  }

  for (const beat of sourceBeats) {
    const id = beat.meta?.id;
    if (typeof id === "string" && !sourceById.has(id)) {
      sourceById.set(id, beat);
    }
  }

  const rejectUnknown = options.rejectUnknownBeats ?? true;
  const requireAll = options.requireAllBeats ?? true;
  const unknownIds = new Set<string>();

  if (rejectUnknown) {
    for (const [id, count] of parsed.idCounts) {
      if (count === 1 && !sourceById.has(id)) {
        unknownIds.add(id);
        const beat = parsed.beats.find((candidate) => candidate.id === id);
        issues.push({
          code: "UNKNOWN_BEAT_ID",
          severity: "error",
          message: `Beat ID ${JSON.stringify(id)} does not exist in the canonical script; no create or update operation was produced.`,
          line: beat?.line,
          beatId: id,
        });
      }
    }
  }

  if (requireAll) {
    for (const id of sourceById.keys()) {
      if (!parsed.idCounts.has(id)) {
        issues.push({
          code: "MISSING_BEAT_ID",
          severity: "error",
          message: `Canonical beat ${JSON.stringify(id)} is missing from the Markdown projection; it was not deleted.`,
          beatId: id,
        });
      }
    }
  }

  const updates: ParsedBeatUpdate[] = [];
  for (const edited of parsed.beats) {
    if (
      parsed.idCounts.get(edited.id) !== 1 ||
      unknownIds.has(edited.id) ||
      invalidSourceIds.has(edited.id)
    ) {
      continue;
    }

    const source = sourceById.get(edited.id);
    if (!source) {
      continue;
    }

    const changes = diffBeat(edited, source);
    if (Object.keys(changes).length > 0) {
      updates.push({ beatId: edited.id, changes });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    beats: parsed.beats,
    issues,
    updates,
  };
}

/**
 * Adapt neutral updates into project operations. Callers may supply a mapper if
 * their command envelope or operation shape adds metadata.
 */
export function toProjectOperations(
  input:
    | readonly ParsedBeatUpdate[]
    | Pick<ParseEditedScriptMarkdownResult, "updates">,
): ScriptUpdateBeatOperation[];
export function toProjectOperations<T>(
  input:
    | readonly ParsedBeatUpdate[]
    | Pick<ParseEditedScriptMarkdownResult, "updates">,
  adapter: (update: ParsedBeatUpdate, index: number) => T,
): T[];
export function toProjectOperations<T>(
  input:
    | readonly ParsedBeatUpdate[]
    | Pick<ParseEditedScriptMarkdownResult, "updates">,
  adapter?: (update: ParsedBeatUpdate, index: number) => T,
): Array<T | ScriptUpdateBeatOperation> {
  const updates = Array.isArray(input)
    ? input
    : (input as Pick<ParseEditedScriptMarkdownResult, "updates">).updates;

  return updates.map((update, index) => {
    if (adapter) {
      return adapter(update, index);
    }
    return {
      type: "script.updateBeat",
      beatId: update.beatId,
      patch: { ...update.changes },
    };
  });
}

/** Alias emphasizing that Markdown is a projection, not canonical storage. */
export const projectScriptToMarkdown = renderScriptMarkdown;

/** Alias for integrations that name the action after the projection. */
export const parseMarkdownProjection = parseEditedScriptMarkdown;

function parseMarkdownInternal(markdown: string): InternalParseResult {
  const normalized = normalizeNewlines(markdown).replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  const issues: MarkdownProjectionIssue[] = [];
  const candidates: MarkerCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (!MARKER_CANDIDATE_PATTERN.test(raw)) {
      continue;
    }

    const match = raw.match(VALID_MARKER_PATTERN);
    const candidate: MarkerCandidate = {
      index,
      line: index + 1,
      raw,
      ...(match ? { id: match[1] } : {}),
    };
    candidates.push(candidate);

    if (!match) {
      issues.push({
        code: "MALFORMED_BEAT_MARKER",
        severity: "error",
        message:
          "Malformed beat marker. Expected <!-- beat:<stable-id> --> on its own line.",
        line: index + 1,
      });
    }
  }

  const firstCandidateIndex = candidates[0]?.index ?? lines.length;
  for (let index = 0; index < firstCandidateIndex; index += 1) {
    if (LEVEL_TWO_HEADING_PATTERN.test(lines[index] ?? "")) {
      issues.push(missingIdIssue(index + 1));
    }
  }

  const idCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.id) {
      idCounts.set(candidate.id, (idCounts.get(candidate.id) ?? 0) + 1);
    }
  }

  const firstLineById = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.id) {
      continue;
    }
    const firstLine = firstLineById.get(candidate.id);
    if (firstLine === undefined) {
      firstLineById.set(candidate.id, candidate.line);
    } else {
      issues.push({
        code: "DUPLICATE_BEAT_ID",
        severity: "error",
        message: `Beat ID ${JSON.stringify(candidate.id)} is duplicated (first declared on line ${firstLine}); all blocks with this ID were ignored.`,
        line: candidate.line,
        beatId: candidate.id,
      });
    }
  }

  const beats: ParsedScriptBeat[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    if (!candidate) {
      continue;
    }
    const nextCandidate = candidates[candidateIndex + 1];
    const endIndex = nextCandidate?.index ?? lines.length;

    if (!candidate.id) {
      continue;
    }

    const headingIndexes: number[] = [];
    for (let index = candidate.index + 1; index < endIndex; index += 1) {
      if (LEVEL_TWO_HEADING_PATTERN.test(lines[index] ?? "")) {
        headingIndexes.push(index);
      }
    }

    if (headingIndexes.length === 0) {
      issues.push({
        code: "MISSING_BEAT_HEADING",
        severity: "error",
        message: `Beat ${JSON.stringify(candidate.id)} has no level-two timing heading.`,
        line: candidate.line,
        beatId: candidate.id,
        field: "timing",
      });
      continue;
    }

    for (const orphanHeadingIndex of headingIndexes.slice(1)) {
      issues.push(missingIdIssue(orphanHeadingIndex + 1));
    }

    if ((idCounts.get(candidate.id) ?? 0) > 1) {
      continue;
    }

    const headingIndex = headingIndexes[0] as number;
    const blockEndIndex = headingIndexes[1] ?? endIndex;
    const unexpectedLine = findUnexpectedContent(
      lines,
      candidate.index + 1,
      headingIndex,
    );
    if (unexpectedLine !== undefined) {
      issues.push({
        code: "UNEXPECTED_CONTENT",
        severity: "warning",
        message: `Content before the heading for beat ${JSON.stringify(candidate.id)} was ignored.`,
        line: unexpectedLine + 1,
        beatId: candidate.id,
      });
    }

    const issueCountBeforeBlock = issues.length;
    const heading = parseBeatHeading(
      lines[headingIndex] ?? "",
      headingIndex + 1,
      candidate.id,
      issues,
    );
    const fields = parseBeatFields(
      lines,
      headingIndex + 1,
      blockEndIndex,
      candidate.id,
      issues,
    );
    const status = fields ? parseStatus(fields.status) : undefined;
    if (fields && !status) {
      issues.push({
        code: "INVALID_STATUS",
        severity: "error",
        message: `Beat ${JSON.stringify(candidate.id)} has unsupported status ${JSON.stringify(fields.status)}.`,
        beatId: candidate.id,
        field: "status",
      });
    }

    const blockHasError = issues
      .slice(issueCountBeforeBlock)
      .some((issue) => issue.severity === "error");
    if (!heading || !fields || !status || blockHasError) {
      continue;
    }

    beats.push({
      id: candidate.id,
      title: heading.title,
      startFrame: heading.startFrame,
      durationFrames: heading.durationFrames,
      narration: fields.narration,
      visualIntent: fields.visualIntent,
      status,
      line: candidate.line,
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    beats,
    issues,
    idCounts,
  };
}

function parseBeatHeading(
  headingLine: string,
  line: number,
  beatId: string,
  issues: MarkdownProjectionIssue[],
): ParsedHeading | undefined {
  const match = headingLine.match(BEAT_HEADING_PATTERN);
  if (!match) {
    issues.push({
      code: "MALFORMED_BEAT_HEADING",
      severity: "error",
      message:
        "Malformed beat heading. Expected ## <start>–<end> — <title> with a supported 30 fps timecode.",
      line,
      beatId,
      field: "timing",
    });
    return undefined;
  }

  const startToken = match[1] as string;
  const endToken = match[2] as string;
  const title = normalizeScalar(match[3] ?? "");
  const startFrame = tryTimecodeToFrames(startToken);
  const endFrame = tryTimecodeToFrames(endToken);

  if (startFrame === undefined || endFrame === undefined) {
    issues.push({
      code: "INVALID_TIMECODE",
      severity: "error",
      message: `Beat ${JSON.stringify(beatId)} contains an invalid 30 fps timecode.`,
      line,
      beatId,
      field: "timing",
    });
    return undefined;
  }

  if (endFrame <= startFrame) {
    issues.push({
      code: "INVALID_FRAME_RANGE",
      severity: "error",
      message: `Beat ${JSON.stringify(beatId)} must end after it starts.`,
      line,
      beatId,
      field: "timing",
    });
    return undefined;
  }

  if (title.length === 0) {
    issues.push({
      code: "MISSING_BEAT_TITLE",
      severity: "error",
      message: `Beat ${JSON.stringify(beatId)} is missing its director-readable title.`,
      line,
      beatId,
      field: "title",
    });
    return undefined;
  }

  return {
    title,
    startFrame,
    durationFrames: endFrame - startFrame,
  };
}

function parseBeatFields(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  beatId: string,
  issues: MarkdownProjectionIssue[],
): Record<ParsedFieldName, string> | undefined {
  const occurrences = new Map<
    ParsedFieldName,
    { index: number; line: number; inline: string }[]
  >();

  for (let index = startIndex; index < endIndex; index += 1) {
    const match = (lines[index] ?? "").match(FIELD_LINE_PATTERN);
    if (!match) {
      continue;
    }
    const field = fieldNameFromLabel(match[1] ?? "");
    const values = occurrences.get(field) ?? [];
    values.push({ index, line: index + 1, inline: match[2] ?? "" });
    occurrences.set(field, values);
  }

  let valid = true;
  for (const field of Object.keys(FIELD_LABELS) as ParsedFieldName[]) {
    const values = occurrences.get(field) ?? [];
    if (values.length === 0) {
      valid = false;
      issues.push({
        code: "MISSING_FIELD",
        severity: "error",
        message: `Beat ${JSON.stringify(beatId)} is missing the ${JSON.stringify(FIELD_LABELS[field])} field.`,
        beatId,
        field,
      });
    } else if (values.length > 1) {
      valid = false;
      for (const duplicate of values.slice(1)) {
        issues.push({
          code: "DUPLICATE_FIELD",
          severity: "error",
          message: `Beat ${JSON.stringify(beatId)} contains more than one ${JSON.stringify(FIELD_LABELS[field])} field.`,
          line: duplicate.line,
          beatId,
          field,
        });
      }
    }
  }

  if (!valid) {
    return undefined;
  }

  const ordered = [...occurrences.entries()]
    .map(([field, [occurrence]]) => ({ field, occurrence: occurrence! }))
    .sort((left, right) => left.occurrence.index - right.occurrence.index);
  const parsed = {} as Record<ParsedFieldName, string>;

  for (let orderedIndex = 0; orderedIndex < ordered.length; orderedIndex += 1) {
    const current = ordered[orderedIndex]!;
    const next = ordered[orderedIndex + 1];
    const continuationEnd = next?.occurrence.index ?? endIndex;
    const valueLines = [
      current.occurrence.inline,
      ...lines.slice(current.occurrence.index + 1, continuationEnd),
    ].map(unescapeStructuralContentLine);
    parsed[current.field] = normalizeMultiline(valueLines.join("\n"));
  }

  return parsed;
}

function diffBeat(
  edited: ParsedScriptBeat,
  source: ProjectableScriptBeat,
): ParsedBeatPatch {
  const changes: ParsedBeatPatch = {};

  if (edited.title !== normalizeScalar(source.title)) {
    changes.title = edited.title;
  }
  if (edited.startFrame !== source.startFrame) {
    changes.startFrame = edited.startFrame;
  }
  if (edited.durationFrames !== source.durationFrames) {
    changes.durationFrames = edited.durationFrames;
  }
  if (edited.narration !== normalizeMultiline(source.narration)) {
    changes.narration = edited.narration;
  }
  if (edited.visualIntent !== normalizeMultiline(source.visualIntent)) {
    changes.visualIntent = edited.visualIntent;
  }
  if (edited.status !== normalizeMultiline(source.meta.status)) {
    changes.status = edited.status;
  }

  return changes;
}

function validateSourceBeats(
  beats: readonly ProjectableScriptBeat[],
): MarkdownProjectionIssue[] {
  const issues: MarkdownProjectionIssue[] = [];
  const seenIds = new Set<string>();

  for (const beat of beats) {
    const id = beat?.meta?.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      issues.push({
        code: "INVALID_SOURCE_BEAT",
        severity: "error",
        message: `A source beat has an unsafe or missing stable ID: ${JSON.stringify(id)}.`,
        ...(typeof id === "string" ? { beatId: id } : {}),
      });
      continue;
    }

    if (seenIds.has(id)) {
      issues.push({
        code: "DUPLICATE_SOURCE_ID",
        severity: "error",
        message: `The canonical source contains duplicate beat ID ${JSON.stringify(id)}.`,
        beatId: id,
      });
    }
    seenIds.add(id);

    if (
      !Number.isSafeInteger(beat.startFrame) ||
      beat.startFrame < 0 ||
      !Number.isSafeInteger(beat.durationFrames) ||
      beat.durationFrames <= 0 ||
      !Number.isSafeInteger(beat.startFrame + beat.durationFrames)
    ) {
      issues.push({
        code: "INVALID_SOURCE_BEAT",
        severity: "error",
        message: `Beat ${JSON.stringify(id)} must have a non-negative integer startFrame and a positive integer durationFrames.`,
        beatId: id,
        field: "timing",
      });
    }

    if (
      typeof beat.title !== "string" ||
      normalizeScalar(beat.title).length === 0 ||
      typeof beat.narration !== "string" ||
      typeof beat.visualIntent !== "string" ||
      !isScriptBeatStatus(beat.meta.status)
    ) {
      issues.push({
        code: "INVALID_SOURCE_BEAT",
        severity: "error",
        message: `Beat ${JSON.stringify(id)} has missing or invalid Markdown projection fields.`,
        beatId: id,
      });
    }
  }

  return issues;
}

function renderField(label: string, value: string): string {
  const lines = normalizeMultiline(value)
    .split("\n")
    .map(escapeStructuralContentLine);
  const first = lines[0] ?? "";
  const rest = lines.slice(1);
  return `**${label}:**${first.length > 0 ? ` ${first}` : ""}${
    rest.length > 0 ? `\n${rest.join("\n")}` : ""
  }`;
}

function escapeStructuralContentLine(line: string): string {
  return line.replace(
    /^(\s*)(\\*)(?=(?:\*\*(?:Narration|Visual\s+intent|Status):\*\*|##(?!#)\s+|<!--\s*beat\b))/i,
    (_match, whitespace: string, slashes: string) =>
      `${whitespace}\\${slashes}`,
  );
}

function unescapeStructuralContentLine(line: string): string {
  return line.replace(
    /^(\s*)\\(?=\\*(?:\*\*(?:Narration|Visual\s+intent|Status):\*\*|##(?!#)\s+|<!--\s*beat\b))/i,
    "$1",
  );
}

function fieldNameFromLabel(label: string): ParsedFieldName {
  const normalized = label.toLowerCase().replace(/\s+/g, " ");
  if (normalized === "visual intent") {
    return "visualIntent";
  }
  if (normalized === "status") {
    return "status";
  }
  return "narration";
}

function parseStatus(value: string): ScriptBeatStatus | undefined {
  const normalized = normalizeScalar(value).toLowerCase();
  return isScriptBeatStatus(normalized) ? normalized : undefined;
}

function formatStatus(status: ScriptBeatStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function isScriptBeatStatus(value: unknown): value is ScriptBeatStatus {
  return (
    typeof value === "string" &&
    (SCRIPT_BEAT_STATUSES as readonly string[]).includes(value)
  );
}

function tryTimecodeToFrames(timecode: string): number | undefined {
  const parts = timecode.trim().split(":");
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }

  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) {
    return undefined;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frames = 0;

  if (numbers.length === 4) {
    [hours, minutes, seconds, frames] = numbers as [number, number, number, number];
  } else if (numbers.length === 3) {
    [hours, minutes, seconds] = numbers as [number, number, number];
  } else {
    [minutes, seconds] = numbers as [number, number];
  }

  if (
    minutes >= 60 && numbers.length !== 2 ||
    seconds >= 60 ||
    frames >= SCRIPT_MARKDOWN_FPS
  ) {
    return undefined;
  }

  const totalSeconds = (hours * 60 + minutes) * 60 + seconds;
  const totalFrames = totalSeconds * SCRIPT_MARKDOWN_FPS + frames;
  return Number.isSafeInteger(totalFrames) ? totalFrames : undefined;
}

function assertFrame(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer frame.`);
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeScalar(value: string): string {
  return normalizeNewlines(value).replace(/\s*\n\s*/g, " ").trim();
}

function normalizeMultiline(value: string): string {
  const lines = normalizeNewlines(value).split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) {
    lines.pop();
  }
  return lines.join("\n");
}

function findUnexpectedContent(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
): number | undefined {
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0 && !/^\s*<!--.*-->\s*$/.test(line)) {
      return index;
    }
  }
  return undefined;
}

function missingIdIssue(line: number): MarkdownProjectionIssue {
  return {
    code: "MISSING_BEAT_ID",
    severity: "error",
    message:
      "A level-two beat heading is not preceded by its own <!-- beat:<stable-id> --> marker.",
    line,
  };
}
