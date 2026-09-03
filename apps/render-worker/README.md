# Praxis render worker

An independent, authenticated Node service that executes the bounded Praxis render manifest. It reads immutable inputs from a filesystem object-store adapter or one-use signed GET URLs, invokes FFmpeg and ffprobe without a shell, validates an H.264/AAC MP4 and JPEG poster, and either stores them locally or streams them to fixed signed PUT destinations.

## Local contract

Copy `.env.example` values into the process environment, then run:

```bash
npm run build --workspace @praxis/render-worker
npm run start --workspace @praxis/render-worker
```

The static `ffmpeg-static` and `ffprobe-static` package binaries are used by default. `PRAXIS_FFMPEG_PATH` and `PRAXIS_FFPROBE_PATH` select system binaries instead, and the container also installs a system FFmpeg fallback. If npm reports that `ffmpeg-static`'s install script was blocked, approve that dependency script under the repository's npm policy or set `PRAXIS_FFMPEG_PATH` to an installed executable before running the opt-in integration test.

Routes:

- `GET /health` — unauthenticated liveness only.
- `POST /render` — authenticated, waits for one render result.
- `POST /jobs/:jobId/cancel` — authenticated cancellation of an active local process.

All POST routes require a short-lived job token:

```text
Authorization: Bearer v1.<payload>.<signature>
payload   = base64url(UTF8(JSON.stringify({ jobId, expiresAt })))
signature = base64url(HMAC-SHA256(PRAXIS_RENDER_AUTH_SECRET, "v1." + payload))
expiresAt = Unix epoch seconds
```

The worker verifies the signature, expiration, configured maximum TTL, and exact body/path `jobId`. Static bearer auth is disabled unless `PRAXIS_RENDER_ALLOW_STATIC_AUTH=1`, and configuration rejects that escape hatch when `NODE_ENV=production`. A render body is:

```json
{
  "jobId": "job_render_01",
  "manifestSha256": "<64 lowercase hex characters>",
  "manifest": { "schemaVersion": "1" },
  "assetAccess": [
    { "assetVersionId": "asset_version_01", "getUrl": "https://short-lived.example/input" }
  ],
  "outputDestinations": {
    "video": {
      "objectKey": "projects/project_01/renders/7/render_01.mp4",
      "putUrl": "https://short-lived.example/video"
    },
    "poster": {
      "objectKey": "projects/project_01/renders/7/render_01.jpg",
      "putUrl": "https://short-lived.example/poster"
    }
  }
}
```

The complete manifest must validate as `@praxis/render-manifest`; transport URLs remain outside its canonical hash. When `assetAccess` is present it must contain exactly one unique GET URL for every manifest asset and no extras. Downloads are streamed into the bounded job directory, redirects are rejected, and byte length plus SHA-256 must match before FFmpeg runs. Without it, asset `objectKey` values are resolved only beneath `PRAXIS_OBJECT_STORE_ROOT`.

When `outputDestinations` is present, both immutable object keys must match the manifest's revision-scoped keys. Validated files are streamed once with fixed PUT requests carrying `Content-Type`, exact `Content-Length`, and `x-praxis-sha256`. Without destinations, outputs are stored locally at:

```text
projects/<projectId>/renders/<projectRevision>/<renderId>.mp4
projects/<projectId>/renders/<projectRevision>/<renderId>.jpg
```

Signed URLs are never added to the result, manifest, logs, or stored metadata. The credential-free response always contains the logical object keys plus hashes, byte lengths, dimensions, duration, and codecs.

The first executor supports still images, bounded text overlays, narration/music/audio, cuts, fades, adjacent-still dissolves, H.264, AAC, and `yuv420p`. Text is encoded into an escaped, generated ASS document and rendered by FFmpeg/libass; content, size, color, weight/style, alignment, letter spacing, optional background, and opacity come from the canonical clip. The renderer image pins one declared canonical family/weight/style and maps it to the bundled TTF's internal ASS family name; other faces are rejected before FFmpeg runs. This first subset requires `lineHeight: 1` and a configured weight of 400 or 700 because libass does not expose arbitrary CSS-like line height or numeric variable-font axes. Treat FFmpeg, ffprobe, font, or mapping changes as renderer changes and bump `PRAXIS_RENDERER_VERSION`. The worker rejects arbitrary URLs, paths, codecs, clip transforms, video inputs, captions, and unknown effects.
