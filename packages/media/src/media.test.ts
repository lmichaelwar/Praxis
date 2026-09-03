import { describe, expect, it } from "vitest";
import { createSilentWav, inspectWav, padPcmWavToDuration, sha256Hex } from "./bytes";
import { contentAddressedAssetKey } from "./object-store";
import { DeterministicSpeechProvider } from "./providers";

describe("immutable media helpers", () => {
  it("hashes bytes and builds content-addressed keys", async () => {
    const hash = await sha256Hex(new TextEncoder().encode("praxis"));
    expect(hash).toHaveLength(64);
    expect(contentAddressedAssetKey("project_demo", hash, "image/png")).toBe(
      `projects/project_demo/assets/sha256/${hash}.png`,
    );
  });

  it("produces a deterministic renderable WAV", async () => {
    const bytes = createSilentWav(1_500);
    expect(inspectWav(bytes).durationMs).toBe(1_500);
    const provider = new DeterministicSpeechProvider();
    const request = {
      assetId: "asset_narration",
      provider: "fake" as const,
      format: "wav" as const,
      text: "The fax machine remembers.",
    };
    const first = await provider.generate(request, new AbortController().signal);
    const second = await provider.generate(request, new AbortController().signal);
    expect(await sha256Hex(first.bytes)).toBe(await sha256Hex(second.bytes));
  });

  it("pads PCM WAV narration to a render-safe minimum duration", () => {
    const original = createSilentWav(500, 24_000);
    const padded = padPcmWavToDuration(original, 2_000);
    expect(inspectWav(padded).durationMs).toBe(2_000);
    expect(padded.byteLength).toBeGreaterThan(original.byteLength);
    expect(padPcmWavToDuration(padded, 1_000)).toBe(padded);
  });

  it("accepts and canonicalizes a completed streaming WAV with sentinel lengths", () => {
    const streaming = createSilentWav(500, 24_000);
    const view = new DataView(streaming.buffer);
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(40, 0xffffffff, true);

    expect(inspectWav(streaming).durationMs).toBe(500);
    const padded = padPcmWavToDuration(streaming, 2_000);
    expect(inspectWav(padded).durationMs).toBe(2_000);
    expect(new DataView(padded.buffer).getUint32(4, true)).toBe(padded.byteLength - 8);
    expect(new DataView(padded.buffer).getUint32(40, true)).toBe(padded.byteLength - 44);
  });
});
