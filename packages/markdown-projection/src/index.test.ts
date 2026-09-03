import { describe, expect, it } from "vitest";

import {
  framesToTimecode,
  parseEditedScriptMarkdown,
  parseScriptMarkdown,
  renderScriptMarkdown,
  timecodeToFrames,
  toProjectOperations,
  type ProjectableScriptBeat,
} from "./index";

const sourceBeats: readonly ProjectableScriptBeat[] = [
  {
    meta: { id: "beat_01", status: "approved" },
    title: "The premise",
    startFrame: 0,
    durationFrames: 121,
    narration:
      "The machine has been waiting for a question.\n\nIt has excellent patience.",
    visualIntent: "Empty fluorescent corridor. Fax machine at the far end.",
  },
  {
    meta: { id: "beat_02", status: "draft" },
    title: "The answer",
    startFrame: 121,
    durationFrames: 74,
    narration: "At last, the paper begins to move.",
    visualIntent: "Slow push toward the fax tray.",
  },
];

describe("30 fps timecodes", () => {
  it("preserves exact frame positions", () => {
    expect(framesToTimecode(121)).toBe("00:00:04:01");
    expect(timecodeToFrames("00:00:04:01")).toBe(121);
    expect(timecodeToFrames("01:02")).toBe(1_860);
  });
});

describe("Markdown projection round trip", () => {
  it("preserves every projected field without producing false updates", () => {
    const markdown = renderScriptMarkdown(sourceBeats);

    expect(markdown).toContain("<!-- beat:beat_01 -->");
    expect(markdown).toContain(
      "## 00:00:00:00–00:00:04:01 — The premise",
    );

    const parsed = parseEditedScriptMarkdown(markdown, sourceBeats);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.updates).toEqual([]);
    expect(parsed.beats).toMatchObject([
      {
        id: "beat_01",
        title: "The premise",
        startFrame: 0,
        durationFrames: 121,
        narration:
          "The machine has been waiting for a question.\n\nIt has excellent patience.",
        visualIntent:
          "Empty fluorescent corridor. Fax machine at the far end.",
        status: "approved",
      },
      {
        id: "beat_02",
        startFrame: 121,
        durationFrames: 74,
      },
    ]);
  });

  it("round trips content that resembles projection syntax", () => {
    const beats: readonly ProjectableScriptBeat[] = [
      {
        ...sourceBeats[0]!,
        narration:
          "Opening line\n**Status:** this is narration\n<!-- beat:not_an_id -->",
      },
    ];
    const markdown = renderScriptMarkdown(beats);
    const parsed = parseEditedScriptMarkdown(markdown, beats);

    expect(parsed.ok).toBe(true);
    expect(parsed.beats[0]?.narration).toBe(beats[0]?.narration);
    expect(parsed.updates).toEqual([]);
  });
});

describe("targeted update detection", () => {
  it("returns only changed fields for only the edited beat", () => {
    const original = renderScriptMarkdown(sourceBeats);
    const edited = original.replace(
      "At last, the paper begins to move.",
      "The oracle finally answers.",
    );

    const parsed = parseEditedScriptMarkdown(edited, sourceBeats);
    expect(parsed.ok).toBe(true);
    expect(parsed.updates).toEqual([
      {
        beatId: "beat_02",
        changes: { narration: "The oracle finally answers." },
      },
    ]);
    expect(toProjectOperations(parsed)).toEqual([
      {
        type: "script.updateBeat",
        beatId: "beat_02",
        patch: { narration: "The oracle finally answers." },
      },
    ]);
  });

  it("reports frame-exact timing edits as a minimal patch", () => {
    const edited = renderScriptMarkdown(sourceBeats).replace(
      "00:00:04:01–00:00:06:15",
      "00:00:04:02–00:00:06:17",
    );
    const parsed = parseEditedScriptMarkdown(edited, sourceBeats);

    expect(parsed.updates).toContainEqual({
      beatId: "beat_02",
      changes: { startFrame: 122, durationFrames: 75 },
    });
  });
});

describe("defensive parsing", () => {
  it("returns structured issues for malformed, duplicate, and missing IDs", () => {
    const malformed = [
      "<!-- beat:beat_01 -->",
      "## 00:00:00:00–00:00:04:01 — First copy",
      "",
      "**Narration:** Changed but ambiguous",
      "",
      "**Visual intent:** Hallway",
      "",
      "**Status:** approved",
      "",
      "<!-- beat:beat_01 -->",
      "## 00:00:04:01–00:00:06:15 — Duplicate",
      "",
      "**Narration:** Duplicate",
      "",
      "**Visual intent:** Tray",
      "",
      "**Status:** draft",
      "",
      "<!-- beat: -->",
      "## 00:00:07:00–00:00:06:00 — Broken range",
      "",
    ].join("\n");

    const parsed = parseEditedScriptMarkdown(malformed, sourceBeats);
    const codes = parsed.issues.map((issue) => issue.code);

    expect(parsed.ok).toBe(false);
    expect(codes).toContain("DUPLICATE_BEAT_ID");
    expect(codes).toContain("MALFORMED_BEAT_MARKER");
    expect(codes).toContain("MISSING_BEAT_ID");
    expect(parsed.updates).toEqual([]);
  });

  it("does not turn omitted or unknown beats into mutations", () => {
    const markdown = renderScriptMarkdown([sourceBeats[0]!]).replace(
      "beat_01",
      "beat_unknown",
    );
    const parsed = parseEditedScriptMarkdown(markdown, sourceBeats);

    expect(parsed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["UNKNOWN_BEAT_ID", "MISSING_BEAT_ID"]),
    );
    expect(parsed.updates).toEqual([]);
  });

  it("rejects malformed headings and missing structured fields", () => {
    const parsed = parseScriptMarkdown([
      "<!-- beat:beat_01 -->",
      "## tomorrow–later — Unscheduled",
      "",
      "**Narration:** Words",
    ].join("\n"));

    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["MALFORMED_BEAT_HEADING", "MISSING_FIELD"]),
    );
    expect(parsed.beats).toEqual([]);
  });
});
