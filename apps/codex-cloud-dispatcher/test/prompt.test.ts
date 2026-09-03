import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { buildDispatchPrompt } from "../src/prompt";
import { CLAIM_TICKET, agentRun, dispatchLease } from "./helpers";

describe("dispatch prompt", () => {
  it("carries immutable identity and the one-use ticket without exposing it through inspection", () => {
    const prompt = buildDispatchPrompt({
      lease: dispatchLease({ run: agentRun({ stages: ["script", "edit"], mode: "propose" }) }),
      praxisApiBaseUrl: "https://staging.praxis.example/api",
      objective: "Revise the script, preserve locked scenes, and construct the rough cut.",
    });

    expect(prompt.reveal()).toContain("AgentRun ID: run_fax_01");
    expect(prompt.reveal()).toContain("Dispatch attempt ID: attempt_fax_01");
    expect(prompt.reveal()).toContain(CLAIM_TICKET);
    expect(prompt.reveal()).toContain("Project base revision: 15");
    expect(prompt.reveal()).toContain("Delegated stages (exact): script, edit");
    expect(prompt.reveal()).toContain("Authority mode: propose");
    expect(prompt.reveal()).toContain("This is propose mode: do not commit authoritative project mutations or enqueue jobs");
    expect(prompt.reveal()).toContain("do not create media or render jobs");
    expect(prompt.reveal()).toContain("Denied entity IDs: scene_locked_01");
    expect(String(prompt)).not.toContain(CLAIM_TICKET);
    expect(inspect(prompt)).not.toContain(CLAIM_TICKET);
    expect(JSON.stringify(prompt)).not.toContain(CLAIM_TICKET);
    expect(prompt.redact(`failure around ${CLAIM_TICKET}`)).toBe("failure around [REDACTED]");
  });

  it("rejects mutable or malformed dispatch identities", () => {
    expect(() => buildDispatchPrompt({
      lease: dispatchLease({ attemptId: "attempt\nmalformed" }),
      praxisApiBaseUrl: "https://staging.praxis.example",
      objective: "Bounded work",
    })).toThrow(/stable Praxis identifier/);
  });

  it("rejects malformed delegated authority", () => {
    expect(() => buildDispatchPrompt({
      lease: dispatchLease({ run: agentRun({ stages: ["script", "script"] }) }),
      praxisApiBaseUrl: "https://staging.praxis.example",
      objective: "Bounded work",
    })).toThrow(/delegated stages are invalid/);

    expect(() => buildDispatchPrompt({
      lease: dispatchLease({ run: agentRun({ mode: "execute" as "act" }) }),
      praxisApiBaseUrl: "https://staging.praxis.example",
      objective: "Bounded work",
    })).toThrow(/authority mode is invalid/);

    expect(() => buildDispatchPrompt({
      lease: dispatchLease({ run: agentRun({ role: "reviewer", mode: "act" }) }),
      praxisApiBaseUrl: "https://staging.praxis.example",
      objective: "Bounded work",
    })).toThrow(/must use propose mode/);
  });
});
