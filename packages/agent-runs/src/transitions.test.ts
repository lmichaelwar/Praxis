import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  AgentRunTransitionError,
  assertAgentRunTransition,
  canTransitionAgentRun,
  isTerminalAgentRunStatus,
} from "./index";

describe("AgentRun transitions", () => {
  it("allows every declared transition and rejects every undeclared transition", () => {
    for (const from of AGENT_RUN_STATUSES) {
      for (const to of AGENT_RUN_STATUSES) {
        const declared = (AGENT_RUN_TRANSITIONS[from] as readonly string[]).includes(to);
        expect(canTransitionAgentRun(from, to), `${from} -> ${to}`).toBe(declared);
      }
    }
  });

  it("supports dispatch uncertainty recovery and the waiting-on-jobs path", () => {
    expect(assertAgentRunTransition("created", "dispatching")).toBe("dispatching");
    expect(assertAgentRunTransition("dispatching", "dispatch_unknown")).toBe("dispatch_unknown");
    expect(assertAgentRunTransition("dispatch_unknown", "claimed")).toBe("claimed");
    expect(assertAgentRunTransition("claimed", "working")).toBe("working");
    expect(assertAgentRunTransition("working", "waiting_on_jobs")).toBe("waiting_on_jobs");
    expect(assertAgentRunTransition("waiting_on_jobs", "completed")).toBe("completed");
  });

  it("keeps terminal states immutable and treats same-status calls as replay handling", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalAgentRunStatus(status)).toBe(true);
      for (const target of AGENT_RUN_STATUSES) {
        expect(canTransitionAgentRun(status, target)).toBe(false);
      }
    }
    expect(canTransitionAgentRun("working", "working")).toBe(false);
  });

  it("throws a structured state-conflict error", () => {
    expect(() => assertAgentRunTransition("created", "completed")).toThrow(AgentRunTransitionError);
    try {
      assertAgentRunTransition("created", "completed");
      expect.fail("Expected transition failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "AGENT_RUN_STATE_CONFLICT",
        from: "created",
        to: "completed",
      });
    }
  });
});
