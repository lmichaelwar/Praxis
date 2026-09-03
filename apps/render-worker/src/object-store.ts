import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface StoredObject {
  objectKey: string;
  path: string;
  sha256: string;
  byteLength: number;
}

const isWithin = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

export async function hashFile(filePath: string): Promise<{ sha256: string; byteLength: number }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteLength += buffer.length;
      digest.update(buffer);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return { sha256: digest.digest("hex"), byteLength };
}

export class LocalObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolveKey(objectKey: string): string {
    if (
      objectKey.startsWith("/") ||
      objectKey.includes("://") ||
      !/^[A-Za-z0-9._/-]+$/.test(objectKey) ||
      objectKey.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("Object key is not a safe relative key");
    }
    const candidate = path.resolve(this.root, objectKey);
    if (!isWithin(this.root, candidate)) throw new Error("Object key escapes the object-store root");
    return candidate;
  }

  async readVerified(
    objectKey: string,
    expectedSha256: string,
    expectedBytes: number,
    maxBytes: number,
  ): Promise<StoredObject> {
    const filePath = this.resolveKey(objectKey);
    const rootRealPath = await realpath(this.root);
    const fileRealPath = await realpath(filePath);
    if (!isWithin(rootRealPath, fileRealPath)) throw new Error("Object symlink escapes the object-store root");
    const fileStat = await stat(fileRealPath);
    if (!fileStat.isFile()) throw new Error("Object-store input is not a regular file");
    if (fileStat.size > maxBytes) throw new Error(`Object exceeds the ${maxBytes}-byte input limit`);
    if (fileStat.size !== expectedBytes) throw new Error("Object byte length does not match trusted metadata");
    const hashed = await hashFile(fileRealPath);
    if (hashed.sha256 !== expectedSha256) throw new Error("Object SHA-256 does not match trusted metadata");
    return { objectKey, path: fileRealPath, ...hashed };
  }

  async putImmutable(objectKey: string, sourcePath: string): Promise<StoredObject> {
    const destination = this.resolveKey(objectKey);
    await mkdir(path.dirname(destination), { recursive: true });
    const [rootRealPath, parentRealPath] = await Promise.all([
      realpath(this.root),
      realpath(path.dirname(destination)),
    ]);
    if (!isWithin(rootRealPath, parentRealPath)) {
      throw new Error("Object output parent escapes the object-store root");
    }
    const source = await hashFile(sourcePath);
    try {
      await copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      const existing = await hashFile(destination).catch(() => null);
      if (!existing || existing.sha256 !== source.sha256 || existing.byteLength !== source.byteLength) {
        throw error;
      }
    }
    return { objectKey, path: destination, ...source };
  }
}
