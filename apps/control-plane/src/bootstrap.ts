import type { ProjectRoomClient } from "./project-room";
import type { Env } from "./env";
import type { ProductionProject } from "@praxis/project-schema";
import { contentAddressedAssetKey, createSilentWav, inspectImage, sha256Hex } from "@praxis/media";
import { R2ImmutableObjectStore } from "./r2-store";
import { requireMediaBinding } from "./media-binding";

export interface SeedMediaBootstrapOptions {
  artworkFetch?: (request: Request) => Promise<Response>;
}

type SeedMediaEnv = Pick<Env, "MEDIA" | "PRAXIS_FAKE_IMAGE_URL">;

const fetchCorridor = async (urlValue: string | undefined, options: SeedMediaBootstrapOptions = {}) => {
  if (!urlValue) throw new Error("PRAXIS_FAKE_IMAGE_URL is required to bootstrap the Fax Oracle media fixture");
  const url = new URL(urlValue);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Fax Oracle bootstrap artwork must use HTTPS or local loopback HTTP");
  }
  const response = options.artworkFetch
    ? await options.artworkFetch(new Request(url))
    : await fetch(url);
  if (!response.ok) throw new Error(`Fax Oracle artwork fetch failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Fax Oracle artwork exceeds 25 MB");
  return { bytes, ...inspectImage(bytes) };
};

export const bootstrapSeedMedia = async (
  env: SeedMediaEnv,
  room: ProjectRoomClient,
  project: ProductionProject,
  options: SeedMediaBootstrapOptions = {},
) => {
  const seedVersions = Object.values(project.assets).flatMap((asset) =>
    asset.versions
      .filter((version) => version.provider === "praxis-seed")
      .map((version) => ({ asset, version })),
  );
  if (!seedVersions.length) return;
  const store = new R2ImmutableObjectStore(requireMediaBinding(env));
  const imageVersions = seedVersions.filter(({ asset }) => asset.kind === "image");
  if (imageVersions.length) {
    const image = await fetchCorridor(env.PRAXIS_FAKE_IMAGE_URL, options);
    const sha256 = await sha256Hex(image.bytes);
    const objectKey = contentAddressedAssetKey(project.projectId, sha256, image.mimeType);
    await store.putImmutable(objectKey, image.bytes, {
      mimeType: image.mimeType,
      customMetadata: { projectId: project.projectId, source: "fax-oracle-corridor", actor: "system" },
    });
    for (const { asset, version } of imageVersions) {
      const result = await room.recordAsset({
        assetId: asset.meta.id,
        assetVersionId: version.id,
        projectId: project.projectId,
        kind: "image",
        objectKey,
        sha256,
        mimeType: image.mimeType,
        byteLength: image.bytes.byteLength,
        width: image.width,
        height: image.height,
        provenance: { projectRevision: project.revision, creationActor: "system", source: "fax-oracle-corridor" },
        createdAt: version.createdAt,
      });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    }
  }

  const audioVersions = seedVersions.filter(({ asset }) => asset.kind === "audio" || asset.kind === "music");
  if (audioVersions.length) {
    const audio = createSilentWav(Math.round((project.timeline.durationFrames / project.timeline.fps) * 1_000));
    const sha256 = await sha256Hex(audio);
    const objectKey = contentAddressedAssetKey(project.projectId, sha256, "audio/wav");
    await store.putImmutable(objectKey, audio, {
      mimeType: "audio/wav",
      customMetadata: { projectId: project.projectId, source: "deterministic-silence", actor: "system" },
    });
    for (const { asset, version } of audioVersions) {
      const result = await room.recordAsset({
        assetId: asset.meta.id,
        assetVersionId: version.id,
        projectId: project.projectId,
        kind: asset.kind,
        objectKey,
        sha256,
        mimeType: "audio/wav",
        byteLength: audio.byteLength,
        durationMs: Math.round((project.timeline.durationFrames / project.timeline.fps) * 1_000),
        provenance: { projectRevision: project.revision, creationActor: "system", source: "deterministic-silence" },
        createdAt: version.createdAt,
      });
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    }
  }
};
