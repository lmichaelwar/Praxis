import { sha256Hex } from "./bytes";

export interface ImmutableObjectMetadata {
  mimeType: string;
  sha256: string;
  byteLength: number;
  customMetadata: Record<string, string>;
}

export interface ImmutableObject extends ImmutableObjectMetadata {
  key: string;
  bytes: Uint8Array;
}

export interface ImmutableObjectStore {
  putImmutable(key: string, bytes: Uint8Array, metadata: Omit<ImmutableObjectMetadata, "sha256" | "byteLength">): Promise<ImmutableObjectMetadata>;
  get(key: string): Promise<ImmutableObject | undefined>;
  head(key: string): Promise<ImmutableObjectMetadata | undefined>;
}

const safeSegment = (value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9:_-]{2,127}$/.test(value)) throw new Error("Unsafe object-key identifier");
  return value;
};

export const extensionForMime = (mimeType: string): string => {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "video/mp4": "mp4",
    "application/json": "json",
  };
  const extension = extensions[mimeType.toLowerCase()];
  if (!extension) throw new Error(`Unsupported media MIME type: ${mimeType}`);
  return extension;
};

export const contentAddressedAssetKey = (
  projectId: string,
  sha256: string,
  mimeType: string,
): string => {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256 value");
  return `projects/${safeSegment(projectId)}/assets/sha256/${sha256}.${extensionForMime(mimeType)}`;
};

export const renderObjectKey = (projectId: string, revision: number, renderId: string, kind: "video" | "poster" | "manifest") => {
  const extension = kind === "video" ? "mp4" : kind === "poster" ? "jpg" : "json";
  return `projects/${safeSegment(projectId)}/renders/${Math.max(0, Math.trunc(revision))}/${safeSegment(renderId)}.${extension}`;
};

export const verifyBytes = async (bytes: Uint8Array, expectedSha256: string, expectedLength?: number) => {
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) throw new Error("Immutable object byte length mismatch");
  const actual = await sha256Hex(bytes);
  if (actual !== expectedSha256) throw new Error("Immutable object SHA-256 mismatch");
};
