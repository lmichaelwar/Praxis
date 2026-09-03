/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createSeedProject } from "@praxis/project-schema";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { commandActorEnvelope, normalizeCommand } from "../src/actor";
import type { AuthenticatedActor } from "../src/env";
import type { ProjectRoomRpc, RoomResult } from "../src/project-room";

const director: AuthenticatedActor = {
  kind: "director",
  id: "access:director@example.com",
  deniedEntityIds: [],
  scopes: [],
  owner: true,
  authentication: "cloudflare_access",
};
const capabilityActor: AuthenticatedActor = {
  kind: "codex",
  id: "capability-browser",
  deniedEntityIds: [],
  scopes: ["project:read", "command:write"],
  owner: false,
  authentication: "capability",
};

let room: ProjectRoomRpc;

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

beforeEach(async () => {
  room = env.PROJECT_ROOMS.getByName(`actor-attribution-${crypto.randomUUID()}`) as unknown as ProjectRoomRpc;
  valueOf(await room.initialize(createSeedProject()));
});

const commandBody = (operation: object, requestedKind: "director" | "codex" | "system") => ({
  commandId: `command_actor_${crypto.randomUUID()}`,
  idempotencyKey: `actor-${crypto.randomUUID()}`,
  baseRevision: 1,
  actor: { kind: requestedKind, sessionId: "untrusted-caller-value" },
  reason: "Actor attribution test",
  createdAt: "2026-09-03T16:00:00.000Z",
  operations: [operation],
});

describe("authenticated command actor attribution", () => {
  it("keeps ordinary browser commands attributed to the authenticated director", () => {
    expect(commandActorEnvelope(commandBody({}, "director"), director)).toEqual({
      kind: "director",
      sessionId: "access:director_example_com",
    });
    expect(commandActorEnvelope(commandBody({}, "system"), director)).toEqual({
      kind: "director",
      sessionId: "access:director_example_com",
    });
  });

  it("allows only the director-to-Codex privilege downgrade", () => {
    expect(commandActorEnvelope(commandBody({}, "codex"), director)).toEqual({
      kind: "codex",
      sessionId: "session_webmcp",
    });
    expect(commandActorEnvelope(commandBody({}, "director"), capabilityActor)).toEqual({
      kind: "codex",
      sessionId: "capability-browser",
    });
    expect(commandActorEnvelope(commandBody({}, "system"), capabilityActor)).toEqual({
      kind: "codex",
      sessionId: "capability-browser",
    });
  });

  it("persists WebMCP mutations in the ledger as Codex", async () => {
    const body = commandBody(
      { type: "script.updateBeat", beatId: "beat_01", patch: { narration: "Revised through WebMCP." } },
      "codex",
    );
    const result = valueOf(await room.applyCommand(normalizeCommand(body, "project_fax_oracle", director)));
    expect(result.revision).toBe(2);
    const hydration = valueOf(await room.getHydration());
    expect(hydration.history.entries[0]?.actorKind).toBe("codex");
    expect(hydration.project.script.beats[0]?.meta.lastEditedBy).toBe("codex");
  });

  it("applies Codex lock restrictions to downgraded WebMCP commands", async () => {
    const body = commandBody(
      { type: "script.updateBeat", beatId: "beat_03", patch: { narration: "Attempted locked edit." } },
      "codex",
    );
    const result = await room.applyCommand(normalizeCommand(body, "project_fax_oracle", director));
    expect(result).toMatchObject({
      ok: false,
      status: 423,
      error: { code: "ENTITY_LOCKED", entityId: "scene_03" },
    });
  });
});
