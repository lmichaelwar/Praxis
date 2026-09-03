import type { ImageGenerationRequest, SpeechGenerationRequest } from "@praxis/jobs";
import { createSilentWav, decodeBase64Bounded, inspectImage, inspectWav, sha256Hex } from "./bytes";

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  provider: string;
  model: string;
  promptHash: string;
  costUsd?: number;
}

export interface GeneratedSpeech {
  bytes: Uint8Array;
  mimeType: "audio/wav";
  durationMs: number;
  provider: string;
  model: string;
  voice: string;
  textHash: string;
  costUsd?: number;
}

export interface ImageGenerationProvider {
  generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<GeneratedImage>;
}

export interface SpeechGenerationProvider {
  generate(request: SpeechGenerationRequest & { text: string }, signal: AbortSignal): Promise<GeneratedSpeech>;
}

export class DeterministicImageProvider implements ImageGenerationProvider {
  constructor(
    private readonly fallback: { bytes: Uint8Array; model?: string },
  ) {}

  async generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<GeneratedImage> {
    if (signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const metadata = inspectImage(this.fallback.bytes);
    return {
      bytes: this.fallback.bytes,
      ...metadata,
      provider: "fake",
      model: this.fallback.model ?? "fax-oracle-corridor-v1",
      promptHash: await sha256Hex(new TextEncoder().encode(request.prompt)),
      costUsd: 0,
    };
  }
}

export class DeterministicSpeechProvider implements SpeechGenerationProvider {
  async generate(request: SpeechGenerationRequest & { text: string }, signal: AbortSignal): Promise<GeneratedSpeech> {
    if (signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
    const durationMs = Math.max(1_000, Math.min(120_000, Math.round(request.text.length * 55)));
    const bytes = createSilentWav(durationMs);
    return {
      bytes,
      mimeType: "audio/wav",
      durationMs: inspectWav(bytes).durationMs,
      provider: "fake",
      model: "deterministic-silence-v1",
      voice: request.voice ?? "alloy",
      textHash: await sha256Hex(new TextEncoder().encode(request.text)),
      costUsd: 0,
    };
  }
}

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string }>;
}

const providerError = async (response: Response): Promise<Error> => {
  let requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message?.slice(0, 500) ?? `Provider request failed with HTTP ${response.status}`;
    return new Error(requestId ? `${message} (request ${requestId})` : message);
  } catch {
    return new Error(requestId ? `Provider request failed with HTTP ${response.status} (request ${requestId})` : `Provider request failed with HTTP ${response.status}`);
  }
};

export class OpenAIImageProvider implements ImageGenerationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly apiBaseUrl = "https://api.openai.com/v1",
  ) {}

  async generate(request: ImageGenerationRequest, signal: AbortSignal): Promise<GeneratedImage> {
    const model = request.model ?? this.defaultModel;
    const response = await fetch(`${this.apiBaseUrl}/images/generations`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        output_format: request.format,
        n: 1,
      }),
    });
    if (!response.ok) throw await providerError(response);
    const payload = (await response.json()) as OpenAIImageResponse;
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) throw new Error("OpenAI image response did not contain image bytes");
    const bytes = decodeBase64Bounded(encoded, 25 * 1024 * 1024);
    const metadata = inspectImage(bytes);
    const expectedMime = request.format === "jpeg" ? "image/jpeg" : `image/${request.format}`;
    if (metadata.mimeType !== expectedMime) throw new Error("OpenAI image encoding did not match the requested format");
    return {
      bytes,
      ...metadata,
      provider: "openai",
      model,
      promptHash: await sha256Hex(new TextEncoder().encode(request.prompt)),
    };
  }
}

export class OpenAISpeechProvider implements SpeechGenerationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly defaultVoice: string,
    private readonly apiBaseUrl = "https://api.openai.com/v1",
  ) {}

  async generate(request: SpeechGenerationRequest & { text: string }, signal: AbortSignal): Promise<GeneratedSpeech> {
    const model = request.model ?? this.defaultModel;
    const voice = request.voice ?? this.defaultVoice;
    const response = await fetch(`${this.apiBaseUrl}/audio/speech`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: request.text,
        voice,
        instructions: request.instructions,
        response_format: "wav",
      }),
    });
    if (!response.ok) throw await providerError(response);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 50 * 1024 * 1024) throw new Error("OpenAI speech output exceeds the configured byte limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("OpenAI speech output exceeds the configured byte limit");
    const metadata = inspectWav(bytes);
    return {
      bytes,
      mimeType: metadata.mimeType,
      durationMs: metadata.durationMs,
      provider: "openai",
      model,
      voice,
      textHash: await sha256Hex(new TextEncoder().encode(request.text)),
    };
  }
}
