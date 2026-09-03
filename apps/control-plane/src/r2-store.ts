import { sha256Hex, type ImmutableObjectMetadata, type ImmutableObjectStore } from "@praxis/media";

export class R2ImmutableObjectStore implements ImmutableObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putImmutable(
    key: string,
    bytes: Uint8Array,
    metadata: Omit<ImmutableObjectMetadata, "sha256" | "byteLength">,
  ): Promise<ImmutableObjectMetadata> {
    const sha256 = await sha256Hex(bytes);
    const existing = await this.bucket.head(key);
    if (existing) {
      if (
        existing.size !== bytes.byteLength ||
        existing.customMetadata?.sha256 !== sha256 ||
        existing.httpMetadata?.contentType !== metadata.mimeType
      ) throw new Error("Immutable object key already contains different content");
      return {
        mimeType: metadata.mimeType,
        sha256,
        byteLength: existing.size,
        customMetadata: existing.customMetadata ?? {},
      };
    }
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const result = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: metadata.mimeType, cacheControl: "private, max-age=31536000, immutable" },
      customMetadata: { ...metadata.customMetadata, sha256 },
      sha256,
    });
    if (!result) {
      const raced = await this.bucket.head(key);
      if (raced?.size === bytes.byteLength && raced.customMetadata?.sha256 === sha256) {
        return { mimeType: metadata.mimeType, sha256, byteLength: raced.size, customMetadata: raced.customMetadata ?? {} };
      }
      throw new Error("Immutable object write precondition failed");
    }
    return { mimeType: metadata.mimeType, sha256, byteLength: result.size, customMetadata: result.customMetadata ?? {} };
  }

  async get(key: string) {
    const object = await this.bucket.get(key);
    if (!object?.body) return undefined;
    const bytes = new Uint8Array(await object.arrayBuffer());
    return {
      key,
      bytes,
      mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256 ?? "",
      byteLength: object.size,
      customMetadata: object.customMetadata ?? {},
    };
  }

  async head(key: string) {
    const object = await this.bucket.head(key);
    if (!object) return undefined;
    return {
      mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256 ?? "",
      byteLength: object.size,
      customMetadata: object.customMetadata ?? {},
    };
  }
}
