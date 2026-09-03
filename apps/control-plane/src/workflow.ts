import { createHash } from "node:crypto";
import { getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createProjectCommand } from "@praxis/commands";
import type { ImageGenerationRequest, JobOutput, JobRecord, RenderRequest as JobRenderRequest, SpeechGenerationRequest } from "@praxis/jobs";
import {
  contentAddressedAssetKey,
  DeterministicImageProvider,
  DeterministicSpeechProvider,
  inspectImage,
  inspectWav,
  OpenAIImageProvider,
  OpenAISpeechProvider,
  padPcmWavToDuration,
  sha256Hex,
} from "@praxis/media";
import { ProductionProjectSchema, type AssetVersion, type ProductionProject } from "@praxis/project-schema";
import { runPostRenderQc, runPreRenderQc } from "@praxis/qc";
import {
  RenderResultPayloadSchema,
  SignedRenderResultEnvelopeSchema,
  compileRenderManifest,
  renderResultObjectKey,
  renderResultSigningInput,
  type RenderManifest,
  type RenderResultPayload,
  type SignedRenderResultEnvelope,
} from "@praxis/render-manifest";
import { z } from "zod";
import type { Env } from "./env";
import { requireMediaBinding } from "./media-binding";
import type { ProjectRoomClient } from "./project-room";
import { R2ImmutableObjectStore } from "./r2-store";
import { hasR2PresigningConfiguration, presignR2Object } from "./r2-presign";
import { mintRenderInputGrant, mintRenderJobToken, mintRenderUploadGrant } from "./render-upload";

interface WorkflowParams {
  projectId: string;
  jobId: string;
}

interface EnrichedJobRequest {
  jobRequest: {
    jobType: JobRecord["jobType"];
    request: Record<string, unknown>;
    targetEntityIds: string[];
  };
  projectSnapshot: ProductionProject;
  capabilityKey?: string;
}

interface MediaGenerationParameters {
  size?: string;
  format: string;
  quality?: string;
  voice?: string;
  beatIds?: string[];
  instructionsHash?: string;
}

const roomFor = (env: Env, projectId: string) => env.PROJECT_ROOMS.getByName(projectId) as unknown as ProjectRoomClient;

const requireResult = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const boundedTrustedImage = async (urlValue: string | undefined, signal: AbortSignal) => {
  if (!urlValue) throw new Error("PRAXIS_FAKE_IMAGE_URL is required for deterministic image generation");
  const url = new URL(urlValue);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Deterministic image URL must use HTTPS or local loopback HTTP");
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Deterministic image fetch failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 25 * 1024 * 1024) throw new Error("Deterministic image exceeds 25 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Deterministic image exceeds 25 MB");
  inspectImage(bytes);
  return bytes;
};

const resolveSpeechText = (snapshot: ProductionProject, request: SpeechGenerationRequest) => {
  if (request.text) return request.text;
  const selected = request.beatIds?.length ? new Set(request.beatIds) : undefined;
  return snapshot.script.beats
    .filter((beat) => !selected || selected.has(beat.meta.id))
    .sort((left, right) => left.order - right.order)
    .map((beat) => beat.narration.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 4_096);
};

const relevantStateCompatible = (base: ProductionProject, current: ProductionProject, assetId: string, sceneId?: string) => {
  const baseAsset = base.assets[assetId];
  const currentAsset = current.assets[assetId];
  if (!baseAsset || !currentAsset || currentAsset.meta.locked) return false;
  if (baseAsset.meta.revisionUpdated !== currentAsset.meta.revisionUpdated || baseAsset.currentVersionId !== currentAsset.currentVersionId) return false;
  if (sceneId) {
    const baseScene = base.scenes.find((scene) => scene.meta.id === sceneId);
    const currentScene = current.scenes.find((scene) => scene.meta.id === sceneId);
    if (!baseScene || !currentScene || currentScene.meta.locked || baseScene.meta.revisionUpdated !== currentScene.meta.revisionUpdated) return false;
  }
  const lockedConsumer = current.timeline.tracks.some(
    (track) =>
      track.clips.some(
        (clip) =>
          (clip.assetId === assetId || (sceneId !== undefined && clip.sceneId === sceneId)) &&
          (track.meta.locked || clip.meta.locked),
      ),
  );
  return !lockedConsumer;
};

const canonicalAssetKind = (jobType: JobRecord["jobType"]): "image" | "audio" =>
  jobType === "image.generate" ? "image" : "audio";

export const mediaCancellationSettlement = (
  providerDispatchRecorded: boolean,
  estimatedCostUsd: number,
) => ({
  actualCostUsd: providerDispatchRecorded ? estimatedCostUsd : 0,
  costIsEstimate: providerDispatchRecorded,
});

export class MediaWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { projectId, jobId } = event.payload;
    const room = roomFor(this.env, projectId);
    let providerDispatchRecorded = false;
    try {
      const claimed = await step.do(
        "claim media job",
        { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } },
        async () => requireResult(await room.transitionJob(jobId, { expectedStatuses: ["queued"], status: "running" })) as any,
      ) as { job: JobRecord; eventSequence: number };
      const job = claimed.job;
      if (job.jobType !== "image.generate" && job.jobType !== "speech.generate") throw new Error(`Unsupported media workflow job: ${job.jobType}`);
      const enriched = job.request as unknown as EnrichedJobRequest;
      const snapshot = ProductionProjectSchema.parse(enriched.projectSnapshot);

      await step.do(
        "mark media provider dispatch",
        { retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
        async () => requireResult(await room.transitionJob(jobId, { expectedStatuses: ["running"], status: "waiting_external" })) as any,
      );
      providerDispatchRecorded = true;

      const generated = await step.do(
        "generate and store immutable media",
        // OpenAI image and speech generation are billable and do not expose a
        // provider idempotency guarantee, so this step gets exactly one attempt.
        { retries: { limit: 1, delay: "3 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const latest = requireResult(await room.getJob(jobId));
          if (latest.status === "cancel_requested" || latest.status === "cancelled") return { cancelled: true as const };
          const controller = new AbortController();
          let bytes: Uint8Array;
          let mimeType: string;
          let width: number | undefined;
          let height: number | undefined;
          let durationMs: number | undefined;
          let provider: string;
          let model: string;
          let promptOrTextHash: string;
          let voice: string | undefined;
          let assetId: string;
          let sceneId: string | undefined;
          let beatIds: string[] | undefined;
          let generationParameters: MediaGenerationParameters;

          if (job.jobType === "image.generate") {
            const request = enriched.jobRequest.request as unknown as ImageGenerationRequest;
            const adapter = request.provider === "openai"
              ? new OpenAIImageProvider(
                  this.env.OPENAI_API_KEY ?? (() => { throw new Error("OPENAI_API_KEY is not configured"); })(),
                  this.env.PRAXIS_IMAGE_MODEL ?? "gpt-image-2",
                )
              : new DeterministicImageProvider({ bytes: await boundedTrustedImage(this.env.PRAXIS_FAKE_IMAGE_URL, controller.signal) });
            const image = await adapter.generate(request, controller.signal);
            ({ bytes, mimeType, width, height, provider, model } = image);
            promptOrTextHash = image.promptHash;
            assetId = request.assetId;
            sceneId = request.sceneId;
            generationParameters = { size: request.size, format: request.format, quality: request.quality };
          } else {
            const request = enriched.jobRequest.request as unknown as SpeechGenerationRequest;
            const text = resolveSpeechText(snapshot, request);
            if (!text) throw new Error("Selected script contains no narration text");
            const adapter = request.provider === "openai"
              ? new OpenAISpeechProvider(
                  this.env.OPENAI_API_KEY ?? (() => { throw new Error("OPENAI_API_KEY is not configured"); })(),
                  this.env.PRAXIS_TTS_MODEL ?? "gpt-4o-mini-tts",
                  this.env.PRAXIS_TTS_VOICE ?? "alloy",
                )
              : new DeterministicSpeechProvider();
            const speech = await adapter.generate({ ...request, text }, controller.signal);
            const requiredFrames = snapshot.timeline.tracks
              .flatMap((track) => track.clips)
              .filter((clip) => clip.assetId === request.assetId)
              .reduce((maximum, clip) => Math.max(maximum, clip.sourceStartFrame + clip.durationFrames), 0);
            const requiredDurationMs = Math.ceil((requiredFrames / snapshot.timeline.fps) * 1_000);
            bytes = requiredDurationMs > 0 ? padPcmWavToDuration(speech.bytes, requiredDurationMs) : speech.bytes;
            const normalizedSpeech = inspectWav(bytes);
            mimeType = normalizedSpeech.mimeType;
            durationMs = normalizedSpeech.durationMs;
            ({ provider, model, voice } = speech);
            promptOrTextHash = speech.textHash;
            assetId = request.assetId;
            beatIds = request.beatIds;
            generationParameters = {
              format: request.format,
              voice,
              beatIds: request.beatIds,
              instructionsHash: request.instructions
                ? await sha256Hex(new TextEncoder().encode(request.instructions))
                : undefined,
            };
          }

          const sha256 = await sha256Hex(bytes);
          const objectKey = contentAddressedAssetKey(projectId, sha256, mimeType);
          const store = new R2ImmutableObjectStore(requireMediaBinding(this.env));
          const stored = await store.putImmutable(objectKey, bytes, {
            mimeType,
            customMetadata: {
              projectId,
              jobId,
              baseRevision: String(job.baseRevision),
              provider,
              model,
              sourceHash: promptOrTextHash,
              creationActorKind: job.actor.kind,
              creationActorId: job.actor.id,
              targetEntityIds: JSON.stringify(job.targetEntityIds),
              generationParameters: JSON.stringify(generationParameters),
              ...(sceneId ? { sceneId } : {}),
              ...(beatIds?.length ? { beatIds: JSON.stringify(beatIds) } : {}),
            },
          });
          return {
            cancelled: false as const,
            assetId,
            sceneId,
            assetVersionId: `version_${jobId}`,
            objectKey,
            sha256,
            mimeType,
            byteLength: stored.byteLength,
            width,
            height,
            durationMs,
            provider,
            model,
            voice,
            sourceHash: promptOrTextHash,
            beatIds,
            generationParameters,
          };
        },
      );

      if (generated.cancelled) {
        const settlement = mediaCancellationSettlement(providerDispatchRecorded, job.estimatedCostUsd);
        return await step.do("settle cancellation", async () =>
          requireResult(await room.transitionJob(jobId, {
            expectedStatuses: ["cancel_requested", "running", "waiting_external"],
            status: "cancelled",
            ...settlement,
          })) as any,
        );
      }

      const committed = await step.do(
        "atomically record and conditionally attach asset version",
        { retries: { limit: 4, delay: "1 second", backoff: "exponential" } },
        async (context) => {
          const hydration = requireResult(await room.getHydration());
          const current = hydration.project;
          const asset = current.assets[generated.assetId];
          const compatible = relevantStateCompatible(snapshot, current, generated.assetId, generated.sceneId);
          let command: ReturnType<typeof createProjectCommand> | undefined;
          if (asset && !asset.meta.locked && !asset.versions.some((version) => version.id === generated.assetVersionId)) {
            const version: AssetVersion = {
              id: generated.assetVersionId,
              version: Math.max(0, ...asset.versions.map((candidate) => candidate.version)) + 1,
              status: compatible ? "ready" : "stale",
              uri: `/api/projects/${projectId}/assets/${generated.assetVersionId}/access`,
              mimeType: generated.mimeType,
              width: generated.width,
              height: generated.height,
              durationMs: generated.durationMs,
              durationFrames: generated.durationMs ? Math.max(1, Math.round((generated.durationMs / 1_000) * current.metadata.fps)) : undefined,
              createdAt: job.createdAt,
              provider: generated.provider,
              model: generated.model,
              checksum: generated.sha256,
              objectKey: generated.objectKey,
              sha256: generated.sha256,
              byteLength: generated.byteLength,
              provenance: { projectRevision: job.baseRevision, jobId, sourceAssetVersionIds: [] },
            };
            const operations: Parameters<typeof createProjectCommand>[2] = [
              { type: "asset.addVersion", assetId: generated.assetId, version },
            ];
            if (compatible) {
              if (generated.sceneId) operations.push({ type: "scene.setStatus", sceneId: generated.sceneId, status: "approved" });
              operations.push({ type: "asset.selectVersion", assetId: generated.assetId, versionId: generated.assetVersionId });
              for (const track of current.timeline.tracks) {
                for (const clip of track.clips) {
                  if (clip.assetId === generated.assetId || (generated.sceneId && clip.sceneId === generated.sceneId)) {
                    operations.push({
                      type: "timeline.updateClip",
                      clipId: clip.meta.id,
                      patch: { assetVersionId: generated.assetVersionId, status: "approved" },
                    });
                  }
                }
              }
            }
            command = createProjectCommand(projectId, current.revision, operations, {
              actor: { kind: "system", sessionId: "system_media_workflow" },
              commandId: `command_${jobId}`,
              idempotencyKey: `asset-commit:${jobId}`,
              reason: compatible ? `Attach media output from ${jobId}` : `Record stale media output from ${jobId}`,
              createdAt: job.createdAt,
            });
          }

          const output = JobOutputSchemaCompat({
            assetId: generated.assetId,
            assetVersionId: generated.assetVersionId,
            objectKey: generated.objectKey,
            sha256: generated.sha256,
            mimeType: generated.mimeType,
            byteLength: generated.byteLength,
            width: generated.width,
            height: generated.height,
            durationMs: generated.durationMs,
            attached: Boolean(command && compatible),
            stale: !command || !compatible,
            projectRevision: job.baseRevision,
            metadata: {
              provider: generated.provider,
              model: generated.model,
              voice: generated.voice,
              sourceHash: generated.sourceHash,
              creationActor: job.actor,
              targetEntityIds: job.targetEntityIds,
              sceneId: generated.sceneId,
              beatIds: generated.beatIds,
              generationParameters: generated.generationParameters,
            },
          });
          const assetRecord = {
            assetId: generated.assetId,
            assetVersionId: generated.assetVersionId,
            projectId,
            kind: canonicalAssetKind(job.jobType),
            objectKey: generated.objectKey,
            sha256: generated.sha256,
            mimeType: generated.mimeType,
            byteLength: generated.byteLength,
            width: generated.width,
            height: generated.height,
            durationMs: generated.durationMs,
            provenance: {
              projectRevision: job.baseRevision,
              jobId,
              provider: generated.provider,
              model: generated.model,
              voice: generated.voice,
              sourceHash: generated.sourceHash,
              creationActor: job.actor,
              targetEntityIds: job.targetEntityIds,
              sceneId: generated.sceneId,
              beatIds: generated.beatIds,
              generationParameters: generated.generationParameters,
            },
            createdAt: job.createdAt,
          };
          const finalized = await room.finalizeMediaJob({
            jobId,
            expectedStatuses: ["running", "waiting_external"],
            output,
            asset: assetRecord,
            command,
            costIsEstimate: true,
          });
          if (
            !finalized.ok &&
            ["REVISION_CONFLICT", "ENTITY_LOCKED"].includes(finalized.error.code) &&
            context.attempt >= (context.config.retries?.limit ?? 1)
          ) {
            return requireResult(await room.finalizeMediaJob({
              jobId,
              expectedStatuses: ["running", "waiting_external"],
              output: { ...output, attached: false, stale: true },
              asset: assetRecord,
              costIsEstimate: true,
            })) as any;
          }
          return requireResult(finalized) as any;
        },
      );

      return committed;
    } catch (error) {
      return await step.do("record media workflow failure", async () => {
        const current = await room.getJob(jobId);
        if (!current.ok || current.value.status === "failed" || current.value.status === "cancelled" || current.value.status === "succeeded") return current as any;
        const settlement = mediaCancellationSettlement(
          providerDispatchRecorded || current.value.status === "waiting_external",
          current.value.estimatedCostUsd,
        );
        return room.transitionJob(jobId, {
          expectedStatuses: ["queued", "running", "waiting_external", "cancel_requested"],
          status: current.value.status === "cancel_requested" ? "cancelled" : "failed",
          ...settlement,
          errorCode: current.value.status === "cancel_requested" ? "CANCELLED" : "MEDIA_WORKFLOW_FAILED",
          errorMessage: error instanceof Error ? error.message.slice(0, 1_000) : "Media workflow failed",
        }) as any;
      });
    }
  }
}

const JobOutputSchemaCompat = (value: JobOutput): JobOutput => value;

const rendererVisibleApiBase = (env: Env) => {
  const value = env.PRAXIS_API_BASE_URL ?? "http://127.0.0.1:8787";
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("PRAXIS_API_BASE_URL must use HTTPS or a local loopback host");
  url.pathname = url.pathname.replace(/\/$/u, "").replace(/\/api$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
};

const renderWorkerSecret = (env: Env) => {
  const secret = env.PRAXIS_RENDER_AUTH_SECRET ?? env.PRAXIS_RENDER_WORKER_TOKEN ?? "";
  if (secret.length < 32) throw new Error("PRAXIS_RENDER_AUTH_SECRET must contain at least 32 characters");
  return secret;
};

type RenderResultSigningBindings = {
  PRAXIS_RENDER_RESULT_SIGNING_SECRET?: string;
  PRAXIS_RENDER_RESULT_SIGNING_KEY_ID?: string;
  PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON?: string;
};

const renderResultSigningConfig = (env: Env) => {
  const bindings = env as Env & RenderResultSigningBindings;
  const secret = bindings.PRAXIS_RENDER_RESULT_SIGNING_SECRET ?? "";
  if (secret.length < 32) throw new Error("PRAXIS_RENDER_RESULT_SIGNING_SECRET must contain at least 32 characters");
  const keyId = bindings.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID ?? "praxis-render-result-v1";
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId)) {
    throw new Error("PRAXIS_RENDER_RESULT_SIGNING_KEY_ID contains unsupported characters");
  }
  const verificationSecrets = new Map<string, string>([[keyId, secret]]);
  const overlapJson = bindings.PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON;
  if (overlapJson) {
    if (overlapJson.length > 16_384) throw new Error("PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON is too large");
    let overlap: unknown;
    try {
      overlap = JSON.parse(overlapJson);
    } catch {
      throw new Error("PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON must be valid JSON");
    }
    if (!overlap || typeof overlap !== "object" || Array.isArray(overlap)) {
      throw new Error("PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON must be a key-ID to secret object");
    }
    const entries = Object.entries(overlap as Record<string, unknown>);
    if (entries.length > 8) throw new Error("At most eight overlapping render-result verification keys are supported");
    for (const [overlapKeyId, overlapSecret] of entries) {
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(overlapKeyId) || typeof overlapSecret !== "string" || overlapSecret.length < 32) {
        throw new Error("Render-result verification overlap contains an invalid key ID or secret");
      }
      const existing = verificationSecrets.get(overlapKeyId);
      if (existing && existing !== overlapSecret) throw new Error(`Render-result verification key ${overlapKeyId} conflicts with the active signing key`);
      verificationSecrets.set(overlapKeyId, overlapSecret);
    }
  }
  return { secret, keyId, verificationSecrets };
};

export const renderObjectKeys = (manifest: RenderManifest) => ({
  video: `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.mp4`,
  poster: `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.jpg`,
  result: renderResultObjectKey(manifest),
});

const externalRenderWorkerBase = (env: Env) => {
  if (!env.PRAXIS_RENDER_WORKER_URL) throw new Error("PRAXIS_RENDER_WORKER_URL is not configured");
  const base = new URL(env.PRAXIS_RENDER_WORKER_URL);
  const localHostname = ["127.0.0.1", "localhost", "[::1]", "host.docker.internal"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && localHostname)) {
    throw new Error("PRAXIS_RENDER_WORKER_URL must use HTTPS or local development HTTP");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("PRAXIS_RENDER_WORKER_URL cannot contain credentials, a query, or a fragment");
  }
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/`;
  return base;
};

async function buildRenderTransport(env: Env, jobId: string, manifest: RenderManifest) {
  const keys = renderObjectKeys(manifest);
  if (hasR2PresigningConfiguration(env)) {
    const [assetAccess, video, poster, result, existingVideo, existingPoster] = await Promise.all([
      Promise.all(manifest.assets.map(async (asset) => ({
        assetVersionId: asset.assetVersionId,
        getUrl: (await presignR2Object(env, { objectKey: asset.objectKey, method: "GET", expiresInSeconds: 900 })).url,
      }))),
      presignR2Object(env, { objectKey: keys.video, method: "PUT", contentType: "video/mp4", expiresInSeconds: 1_200 }),
      presignR2Object(env, { objectKey: keys.poster, method: "PUT", contentType: "image/jpeg", expiresInSeconds: 1_200 }),
      presignR2Object(env, { objectKey: keys.result, method: "PUT", contentType: "application/json", expiresInSeconds: 1_200 }),
      presignR2Object(env, { objectKey: keys.video, method: "GET", expiresInSeconds: 1_200 }),
      presignR2Object(env, { objectKey: keys.poster, method: "GET", expiresInSeconds: 1_200 }),
    ]);
    return {
      assetAccess,
      outputDestinations: {
        video: { objectKey: keys.video, putUrl: video.url, existingObjectGetUrl: existingVideo.url },
        poster: { objectKey: keys.poster, putUrl: poster.url, existingObjectGetUrl: existingPoster.url },
        result: { objectKey: keys.result, putUrl: result.url },
      },
    };
  }

  const baseUrl = rendererVisibleApiBase(env);
  const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
  const assetAccess = await Promise.all(manifest.assets.map(async (asset) => {
    const grant = await mintRenderInputGrant({
      version: 1,
      projectId: manifest.projectId,
      jobId,
      assetVersionId: asset.assetVersionId,
      objectKey: asset.objectKey,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mimeType: asset.mimeType,
      expiresAt,
    }, env.PRAXIS_CAPABILITY_SIGNING_SECRET);
    return { assetVersionId: asset.assetVersionId, getUrl: `${baseUrl}/internal/render-inputs?grant=${encodeURIComponent(grant)}` };
  }));
  const [videoGrant, posterGrant, resultGrant] = await Promise.all([
    mintRenderUploadGrant({
      version: 1,
      projectId: manifest.projectId,
      jobId,
      part: "video",
      objectKey: keys.video,
      mimeType: "video/mp4",
      expiresAt,
    }, env.PRAXIS_CAPABILITY_SIGNING_SECRET),
    mintRenderUploadGrant({
      version: 1,
      projectId: manifest.projectId,
      jobId,
      part: "poster",
      objectKey: keys.poster,
      mimeType: "image/jpeg",
      expiresAt,
    }, env.PRAXIS_CAPABILITY_SIGNING_SECRET),
    mintRenderUploadGrant({
      version: 1,
      projectId: manifest.projectId,
      jobId,
      part: "result",
      objectKey: keys.result,
      mimeType: "application/json",
      expiresAt,
    }, env.PRAXIS_CAPABILITY_SIGNING_SECRET),
  ]);
  return {
    assetAccess,
    outputDestinations: {
      video: { objectKey: keys.video, putUrl: `${baseUrl}/internal/render-outputs?grant=${encodeURIComponent(videoGrant)}` },
      poster: { objectKey: keys.poster, putUrl: `${baseUrl}/internal/render-outputs?grant=${encodeURIComponent(posterGrant)}` },
      result: { objectKey: keys.result, putUrl: `${baseUrl}/internal/render-outputs?grant=${encodeURIComponent(resultGrant)}` },
    },
  };
}

async function dispatchRender(env: Env, jobId: string, manifestSha256: string, manifest: RenderManifest) {
  const transport = await buildRenderTransport(env, jobId, manifest);
  const authorization = `Bearer ${await mintRenderJobToken(jobId, renderWorkerSecret(env), 900)}`;
  const requestBody = JSON.stringify({ jobId, manifestSha256, manifest, ...transport });
  let response: Response;
  if (env.PRAXIS_RENDER_WORKER_URL) {
    response = await fetch(new URL("render", externalRenderWorkerBase(env)), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: requestBody,
    });
  } else if (env.RENDER_CONTAINERS) {
    const container = getContainer(env.RENDER_CONTAINERS as any, jobId);
    response = await container.fetch(new Request("http://render-worker.local/render", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: requestBody,
    }));
  } else {
    throw new Error("No render worker endpoint or Container binding is configured");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 1_000_000) throw new Error("Render worker returned an oversized response");
  const responseText = await response.text();
  if (responseText.length > 1_000_000) throw new Error("Render worker returned an oversized response");
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error(`Render worker returned invalid JSON with HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string } };
    throw new Error(`${error.error?.code ?? `RENDER_WORKER_HTTP_${response.status}`}: ${error.error?.message ?? "Render worker rejected the job"}`);
  }
  z.object({ ok: z.literal(true), result: RenderResultPayloadSchema }).strict().parse(body);
}

export async function requestRenderCancellation(env: Env, jobId: string): Promise<void> {
  const authorization = `Bearer ${await mintRenderJobToken(jobId, renderWorkerSecret(env), 300)}`;
  let response: Response;
  if (env.PRAXIS_RENDER_WORKER_URL) {
    response = await fetch(new URL(`jobs/${encodeURIComponent(jobId)}/cancel`, externalRenderWorkerBase(env)), {
      method: "POST",
      headers: { authorization },
    });
  } else if (env.RENDER_CONTAINERS) {
    const container = getContainer(env.RENDER_CONTAINERS as any, jobId);
    response = await container.fetch(new Request(`http://render-worker.local/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { authorization },
    }));
  } else {
    return;
  }
  if (!response.ok && response.status !== 404) throw new Error(`Render cancellation returned HTTP ${response.status}`);
  await response.body?.cancel();
}

async function inspectR2Output(
  env: Env,
  expected: { objectKey: string; mimeType: string; maxByteLength: number },
): Promise<{ objectKey: string; sha256: string; byteLength: number; mimeType: string }> {
  const object = await requireMediaBinding(env).get(expected.objectKey);
  if (!object?.body) throw new Error(`Renderer did not upload ${expected.objectKey}`);
  if (object.size <= 0 || object.size > expected.maxByteLength) {
    throw new Error(`Stored output length is invalid for ${expected.objectKey}`);
  }
  if (object.httpMetadata?.contentType !== expected.mimeType) {
    throw new Error(`Stored output content type differs for ${expected.objectKey}`);
  }
  const digest = createHash("sha256");
  let byteLength = 0;
  const reader = object.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > expected.maxByteLength || byteLength > object.size) {
      throw new Error(`Stored output exceeds its reported length for ${expected.objectKey}`);
    }
    digest.update(value);
  }
  if (byteLength !== object.size) throw new Error(`Stored output length differs for ${expected.objectKey}`);
  return { objectKey: expected.objectKey, sha256: digest.digest("hex"), byteLength, mimeType: expected.mimeType };
}

async function verifyR2Output(env: Env, expected: { objectKey: string; sha256: string; byteLength: number; mimeType: string }) {
  const inspected = await inspectR2Output(env, {
    objectKey: expected.objectKey,
    mimeType: expected.mimeType,
    maxByteLength: expected.mimeType === "video/mp4" ? 1_073_741_824 : 26_214_400,
  });
  if (inspected.byteLength !== expected.byteLength || inspected.sha256 !== expected.sha256) {
    throw new Error(`Stored output hash differs for ${expected.objectKey}`);
  }
}

const decodeRenderResultSignature = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Malformed render result signature");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let canonical = "";
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  canonical = btoa(canonical).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  if (canonical !== value) throw new Error("Malformed render result signature");
  return bytes;
};

export async function verifyRenderResultEnvelope(
  envelopeInput: unknown,
  secretOrKeyRing: string | ReadonlyMap<string, string>,
  expectedKeyId?: string,
): Promise<SignedRenderResultEnvelope> {
  const envelope = SignedRenderResultEnvelopeSchema.parse(envelopeInput);
  const secret = typeof secretOrKeyRing === "string"
    ? envelope.keyId === expectedKeyId ? secretOrKeyRing : undefined
    : secretOrKeyRing.get(envelope.keyId);
  if (!secret) throw new Error(`Unexpected render result signing key ${envelope.keyId}`);
  if (secret.length < 32) throw new Error("Render result signing secret must contain at least 32 characters");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(decodeRenderResultSignature(envelope.signature)).buffer,
    new TextEncoder().encode(renderResultSigningInput({ keyId: envelope.keyId, payload: envelope.payload })),
  );
  if (!valid) throw new Error("Invalid render result signature");
  return envelope;
}

export interface VerifiedRenderResult {
  result: RenderResultPayload;
  sidecar: {
    objectKey: string;
    sha256: string;
    byteLength: number;
    keyId: string;
  };
}

async function readRenderResultSidecar(
  env: Env,
  objectKey: string,
): Promise<{ value: unknown; sha256: string; byteLength: number } | undefined> {
  const object = await requireMediaBinding(env).get(objectKey);
  if (!object?.body) return undefined;
  if (object.size <= 0 || object.size > 65_536) throw new Error("Render result sidecar exceeds 64 KiB");
  if (object.httpMetadata?.contentType !== "application/json") {
    throw new Error("Render result sidecar must use application/json");
  }
  const bytes = new Uint8Array(object.size);
  const digest = createHash("sha256");
  const reader = object.body.getReader();
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > object.size || byteLength > 65_536) throw new Error("Render result sidecar length is invalid");
    bytes.set(value, byteLength - value.byteLength);
    digest.update(value);
  }
  if (byteLength !== object.size) throw new Error("Render result sidecar length differs from R2 metadata");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Render result sidecar is not valid UTF-8 JSON");
  }
  return { value, sha256: digest.digest("hex"), byteLength };
}

export async function recoverExistingRenderResult(
  env: Env,
  jobId: string,
  manifestSha256: string,
  manifest: RenderManifest,
): Promise<VerifiedRenderResult | undefined> {
  const keys = renderObjectKeys(manifest);
  const stored = await readRenderResultSidecar(env, keys.result);
  if (!stored) return undefined;
  const signing = renderResultSigningConfig(env);
  const envelope = await verifyRenderResultEnvelope(stored.value, signing.verificationSecrets);
  const result = envelope.payload;
  if (
    result.jobId !== jobId ||
    result.renderId !== manifest.renderId ||
    result.projectId !== manifest.projectId ||
    result.projectRevision !== manifest.projectRevision ||
    result.manifestSha256 !== manifestSha256 ||
    result.renderer.name !== manifest.renderer.name ||
    result.renderer.version !== manifest.renderer.version ||
    result.video.objectKey !== keys.video ||
    result.poster.objectKey !== keys.poster
  ) {
    throw new Error("Signed render result does not match the requested immutable render");
  }
  await Promise.all([verifyR2Output(env, result.video), verifyR2Output(env, result.poster)]);
  return {
    result,
    sidecar: {
      objectKey: keys.result,
      sha256: stored.sha256,
      byteLength: stored.byteLength,
      keyId: envelope.keyId,
    },
  };
}

export class RenderWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { projectId, jobId } = event.payload;
    const room = roomFor(this.env, projectId);
    try {
      const claimed = await step.do("claim render job", async () =>
        requireResult(await room.transitionJob(jobId, { expectedStatuses: ["queued"], status: "running" })) as any,
      ) as { job: JobRecord; eventSequence: number };
      const job = claimed.job;
      if (job.jobType !== "render.preview" && job.jobType !== "render.final") throw new Error(`Unsupported render workflow job: ${job.jobType}`);
      const enriched = job.request as unknown as EnrichedJobRequest;
      const snapshot = ProductionProjectSchema.parse(enriched.projectSnapshot);
      if (snapshot.projectId !== projectId || snapshot.revision !== job.baseRevision) {
        throw new Error("Render job snapshot does not match its project and base revision");
      }
      const renderRequest = enriched.jobRequest.request as unknown as JobRenderRequest;
      const renderId = `render_${jobId}`;
      if (renderRequest.renderId && renderRequest.renderId !== renderId) {
        throw new Error(`Render ID must be ${renderId} so immutable output keys remain unique to this job`);
      }

      const compiled = await step.do("compile and persist immutable render manifest", async () => {
        const hydration = requireResult(await room.getHydration());
        const preRenderQc = await runPreRenderQc({
          project: snapshot,
          assetRecords: hydration.assets,
          expectedRevision: job.baseRevision,
          outputKind: job.jobType === "render.final" ? "final" : "preview",
          rendererVersion: renderRequest.rendererVersion,
        });
        const result = await compileRenderManifest({
          project: snapshot,
          expectedRevision: job.baseRevision,
          renderId,
          kind: job.jobType === "render.final" ? "final" : "preview",
          rendererVersion: renderRequest.rendererVersion,
          assetRecords: hydration.assets,
        });
        const manifestObjectKey = `projects/${projectId}/render-manifests/sha256/${result.sha256}.json`;
        const bytes = new TextEncoder().encode(result.canonicalJson);
        await new R2ImmutableObjectStore(requireMediaBinding(this.env)).putImmutable(manifestObjectKey, bytes, {
          mimeType: "application/json",
          customMetadata: {
            projectId,
            jobId,
            renderId,
            projectRevision: String(job.baseRevision),
            manifestSha256: result.sha256,
            creationActorKind: job.actor.kind,
            creationActorId: job.actor.id,
          },
        });
        return { manifest: result.manifest, manifestSha256: result.sha256, manifestObjectKey, preRenderQc } as any;
      }) as {
        manifest: RenderManifest;
        manifestSha256: string;
        manifestObjectKey: string;
        preRenderQc: Awaited<ReturnType<typeof runPreRenderQc>>;
      };

      const rendered = await step.do(
        "dispatch authenticated render and verify immutable outputs",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          const current = requireResult(await room.getJob(jobId));
          if (current.status === "cancel_requested" || current.status === "cancelled") return { cancelled: true as const };
          let verified = await recoverExistingRenderResult(this.env, jobId, compiled.manifestSha256, compiled.manifest);
          if (!verified) {
            await dispatchRender(this.env, jobId, compiled.manifestSha256, compiled.manifest);
            verified = await recoverExistingRenderResult(this.env, jobId, compiled.manifestSha256, compiled.manifest);
            if (!verified) throw new Error("RENDER_RESULT_MISSING: worker completed without an immutable result sidecar");
          }
          const afterRender = requireResult(await room.getJob(jobId));
          if (afterRender.status === "cancel_requested" || afterRender.status === "cancelled") {
            return { cancelled: true as const };
          }
          return { cancelled: false as const, result: verified.result, sidecar: verified.sidecar };
        },
      );
      if (rendered.cancelled) {
        return step.do("settle render cancellation", async () => {
          const current = requireResult(await room.getJob(jobId));
          if (current.status === "cancelled") return current as any;
          return requireResult(await room.transitionJob(jobId, {
            expectedStatuses: ["running", "cancel_requested"],
            status: "cancelled",
            actualCostUsd: 0,
            costIsEstimate: false,
            errorCode: "CANCELLED",
            errorMessage: "Render job was cancelled",
          })) as any;
        });
      }

      return step.do("atomically settle and record immutable render result", async () => {
        const result = rendered.result;
        const sidecar = rendered.sidecar;
        const createdAt = job.createdAt;
        const videoAssetVersionId = `version_${renderId}`;
        const provenance = {
          projectRevision: job.baseRevision,
          jobId,
          renderer: compiled.manifest.renderer,
          manifestSha256: compiled.manifestSha256,
          renderResult: sidecar,
          creationActor: job.actor,
          targetEntityIds: job.targetEntityIds,
          renderParameters: {
            kind: job.jobType === "render.final" ? "final" : "preview",
            rendererVersion: renderRequest.rendererVersion,
            width: compiled.manifest.canvas.width,
            height: compiled.manifest.canvas.height,
            fps: compiled.manifest.canvas.fps,
          },
        };
        const videoAsset = {
          assetId: renderId,
          assetVersionId: videoAssetVersionId,
          projectId,
          kind: "render" as const,
          objectKey: result.video.objectKey,
          sha256: result.video.sha256,
          mimeType: result.video.mimeType,
          byteLength: result.video.byteLength,
          width: result.video.width,
          height: result.video.height,
          durationMs: result.video.durationMs,
          provenance,
          createdAt,
        };
        const posterAsset = {
          assetId: `${renderId}_poster`,
          assetVersionId: `version_${renderId}_poster`,
          projectId,
          kind: "poster" as const,
          objectKey: result.poster.objectKey,
          sha256: result.poster.sha256,
          mimeType: result.poster.mimeType,
          byteLength: result.poster.byteLength,
          width: result.poster.width,
          height: result.poster.height,
          provenance,
          createdAt,
        };
        const render = {
          renderId,
          projectId,
          jobId,
          projectRevision: job.baseRevision,
          manifestHash: compiled.manifestSha256,
          manifestObjectKey: compiled.manifestObjectKey,
          outputObjectKey: result.video.objectKey,
          posterObjectKey: result.poster.objectKey,
          sha256: result.video.sha256,
          byteLength: result.video.byteLength,
          width: result.video.width,
          height: result.video.height,
          durationMs: result.video.durationMs,
          videoCodec: result.video.videoCodec,
          audioCodec: result.video.audioCodec,
          pixelFormat: result.video.pixelFormat,
          outdated: false,
          createdAt,
        };
        const outputBeforeQc = JobOutputSchemaCompat({
          assetId: renderId,
          assetVersionId: videoAssetVersionId,
          renderId,
          objectKey: result.video.objectKey,
          posterObjectKey: result.poster.objectKey,
          sha256: result.video.sha256,
          posterSha256: result.poster.sha256,
          mimeType: result.video.mimeType,
          byteLength: result.video.byteLength,
          width: result.video.width,
          height: result.video.height,
          durationMs: result.video.durationMs,
          attached: true,
          stale: false,
          projectRevision: job.baseRevision,
          metadata: {
            manifestSha256: compiled.manifestSha256,
            manifestObjectKey: compiled.manifestObjectKey,
            renderResultObjectKey: sidecar.objectKey,
            renderResultSha256: sidecar.sha256,
            renderResultByteLength: sidecar.byteLength,
            renderResultSigningKeyId: sidecar.keyId,
            renderCompletedAt: result.completedAt,
            videoCodec: result.video.videoCodec,
            audioCodec: result.video.audioCodec,
            pixelFormat: result.video.pixelFormat,
            fps: result.video.fps,
            container: result.video.container,
            posterCodec: result.poster.codec,
            posterByteLength: result.poster.byteLength,
            renderer: compiled.manifest.renderer,
            creationActor: job.actor,
            targetEntityIds: job.targetEntityIds,
          },
        });
        const postRenderQc = await runPostRenderQc({
          manifest: compiled.manifest,
          video: {
            objectKey: result.video.objectKey,
            exists: true,
            byteLength: result.video.byteLength,
            sha256: result.video.sha256,
            mimeType: result.video.mimeType,
            container: "mp4",
            durationMs: result.video.durationMs,
            streams: [
              {
                kind: "video",
                codec: result.video.videoCodec,
                width: result.video.width,
                height: result.video.height,
                durationMs: result.video.durationMs,
                pixelFormat: result.video.pixelFormat,
              },
              { kind: "audio", codec: result.video.audioCodec, durationMs: result.video.durationMs },
            ],
          },
          poster: {
            objectKey: result.poster.objectKey,
            exists: true,
            byteLength: result.poster.byteLength,
            sha256: result.poster.sha256,
            mimeType: result.poster.mimeType,
          },
          renderRecord: render,
          jobRecord: {
            ...job,
            status: "succeeded",
            reservedCostUsd: 0,
            settledCostUsd: job.estimatedCostUsd,
            costIsEstimate: true,
            output: outputBeforeQc,
            updatedAt: createdAt,
          },
        });
        if (!postRenderQc.summary.passed) {
          const codes = postRenderQc.findings.filter((finding) => finding.severity === "error").map((finding) => finding.code);
          throw new Error(`POST_RENDER_QC_FAILED: ${[...new Set(codes)].join(", ")}`);
        }
        const output = JobOutputSchemaCompat({
          ...outputBeforeQc,
          metadata: {
            ...outputBeforeQc.metadata,
            qc: { preRender: compiled.preRenderQc, postRender: postRenderQc },
          },
        });
        return requireResult(await room.finalizeRenderJob({
          jobId,
          expectedStatuses: ["running", "waiting_external"],
          output,
          videoAsset,
          posterAsset,
          render,
          costIsEstimate: true,
        })) as any;
      });
    } catch (error) {
      return step.do("record render workflow failure", async () => {
        const current = await room.getJob(jobId);
        if (!current.ok || current.value.status === "failed" || current.value.status === "cancelled" || current.value.status === "succeeded") return current as any;
        const cancelled = current.value.status === "cancel_requested";
        return room.transitionJob(jobId, {
          expectedStatuses: ["queued", "running", "waiting_external", "cancel_requested"],
          status: cancelled ? "cancelled" : "failed",
          actualCostUsd: 0,
          costIsEstimate: false,
          errorCode: cancelled ? "CANCELLED" : "RENDER_WORKFLOW_FAILED",
          errorMessage: cancelled ? "Render job was cancelled" : error instanceof Error ? error.message.slice(0, 1_000) : "Render workflow failed",
        }) as any;
      });
    }
  }
}
