import { AwsClient } from "aws4fetch";
import type { Env } from "./env";
import { sha256HexToBase64 } from "./direct-upload";

export interface PresignedObjectRequest {
  url: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

interface R2S3Configuration {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

const configured = (env: Env): R2S3Configuration | undefined => {
  const values = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: env.R2_BUCKET_NAME,
  };
  if (Object.values(values).every((value) => typeof value === "string" && value.length > 0)) {
    return values as R2S3Configuration;
  }
  return undefined;
};

const encodedObjectPath = (bucketName: string, objectKey: string) =>
  [bucketName, ...objectKey.split("/")].map((segment) => encodeURIComponent(segment)).join("/");

export const hasR2PresigningConfiguration = (env: Env) => configured(env) !== undefined;

export async function presignR2Object(
  env: Env,
  input: {
    objectKey: string;
    method: "GET" | "PUT";
    contentType?: string;
    checksumSha256?: string;
    expiresInSeconds?: number;
  },
): Promise<PresignedObjectRequest> {
  const config = configured(env);
  if (!config) throw new Error("R2 S3 presigning credentials are not configured");
  const expiresInSeconds = Math.min(3_600, Math.max(60, input.expiresInSeconds ?? 900));
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${encodedObjectPath(config.bucketName, input.objectKey)}`;
  const headers: Record<string, string> = {};
  if (input.method === "PUT") {
    headers["if-none-match"] = "*";
    if (input.contentType) headers["content-type"] = input.contentType;
    if (input.checksumSha256) headers["x-amz-checksum-sha256"] = sha256HexToBase64(input.checksumSha256);
  }
  const signer = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  const request = new Request(`${endpoint}?X-Amz-Expires=${expiresInSeconds}`, {
    method: input.method,
    headers,
  });
  // aws4fetch intentionally excludes Content-Type by default. Direct upload
  // grants must bind every returned caller header so neither MIME nor checksum
  // can be changed after issuance.
  const signed = await signer.sign(request, { aws: { signQuery: true, allHeaders: true } });
  return {
    url: signed.url,
    method: input.method,
    headers,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
  };
}
