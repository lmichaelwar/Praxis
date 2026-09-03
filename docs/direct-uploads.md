# Direct browser uploads

Praxis uses a two-step, authenticated registration flow so large imported media goes from the browser directly to R2 and never passes through Worker memory.

1. `POST /api/projects/:projectId/uploads` with lowercase hexadecimal `sha256`, exact `mimeType`, and `byteLength`.
2. Upload the bytes to the returned short-lived `uploadUrl` with every returned header. The grant binds `If-None-Match: *`, `Content-Type`, and the base64 `x-amz-checksum-sha256` value into its SigV4 signature.
3. `POST /api/projects/:projectId/uploads/finalize` with the same integrity fields plus `assetId`, `assetVersionId`, `kind`, `name`, and media metadata (`width`/`height` for images or `durationMs` for audio).
4. Submit the returned `command` to the normal project command endpoint if the imported version should enter the canonical project graph.

Finalization reads only `R2Object` metadata. It requires an exact byte length and MIME match, and compares the requested digest with R2's stored `checksums.sha256`. Missing checksum metadata fails closed with `UPLOAD_CHECKSUM_UNAVAILABLE`; Praxis does not trust browser-provided custom metadata or download the object to recompute a large hash.

The same content-addressed object may be registered idempotently, but the create-only PUT grant prevents replacement of an existing key. Presigned URLs are bearer credentials and expire after 15 minutes.

For browser PUTs, configure the R2 bucket CORS policy to allow the Studio origin, `PUT`, and the three returned request headers. This is separate from the control-plane Worker CORS policy.

Current platform basis:

- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) support direct `PutObject` and signed request headers.
- [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) supports conditional `PutObject`; [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/#2023-05-16) document SHA-256 support on S3 `PutObject`.
- [R2 Workers API checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#checksums) exposes uploader-supplied, R2-verified SHA-256 values on `R2Object` returned by `head()`.
