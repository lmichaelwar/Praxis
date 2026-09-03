const HEX = "0123456789abcdef";

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  let value = "";
  for (const byte of digest) value += HEX[byte >> 4] + HEX[byte & 15];
  return value;
};

export const utf8Bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

export const decodeBase64Bounded = (value: string, maxBytes: number): Uint8Array => {
  const estimated = Math.floor((value.length * 3) / 4);
  if (estimated > maxBytes + 2) throw new Error("Provider output exceeds the configured byte limit");
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("Provider returned invalid base64");
  }
  if (decoded.length > maxBytes) throw new Error("Provider output exceeds the configured byte limit");
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
};

const readU32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);

export interface ImageMetadata {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

const pngMetadata = (bytes: Uint8Array): ImageMetadata | undefined => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return undefined;
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (!width || !height) return undefined;
  return { mimeType: "image/png", width, height };
};

const jpegMetadata = (bytes: Uint8Array): ImageMetadata | undefined => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width && height) return { mimeType: "image/jpeg", width, height };
    }
    offset += 2 + length;
  }
  return undefined;
};

const webpMetadata = (bytes: Uint8Array): ImageMetadata | undefined => {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  ) return undefined;
  const kind = String.fromCharCode(...bytes.slice(12, 16));
  if (kind === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { mimeType: "image/webp", width, height };
  }
  return undefined;
};

export const inspectImage = (bytes: Uint8Array): ImageMetadata => {
  const metadata = pngMetadata(bytes) ?? jpegMetadata(bytes) ?? webpMetadata(bytes);
  if (!metadata) throw new Error("Generated image has an unsupported or malformed image encoding");
  if (metadata.width > 16_384 || metadata.height > 16_384) throw new Error("Generated image dimensions exceed limits");
  return metadata;
};

export interface WavMetadata {
  mimeType: "audio/wav";
  durationMs: number;
  sampleRate: number;
  channels: number;
}

const resolvedWavChunkLength = (type: string, declaredLength: number, availableLength: number) => {
  if (declaredLength <= availableLength) return declaredLength;
  // Streaming WAV encoders cannot know the final payload length when they emit
  // the header, so 0xffffffff is the conventional RIFF/data sentinel. Once the
  // HTTP response has completed, the bounded response remainder is authoritative.
  if (type === "data" && declaredLength === 0xffffffff && availableLength > 0) return availableLength;
  throw new Error("Speech WAV contains a truncated chunk");
};

export const inspectWav = (bytes: Uint8Array): WavMetadata => {
  if (
    bytes.length < 44 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE"
  ) throw new Error("Speech output is not a valid WAV file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = resolvedWavChunkLength(type, view.getUint32(offset + 4, true), bytes.length - offset - 8);
    if (type === "fmt " && length >= 16) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      byteRate = view.getUint32(offset + 16, true);
    } else if (type === "data") {
      dataLength = length;
    }
    offset += 8 + length + (length % 2);
  }
  if (!byteRate || !dataLength || !sampleRate || !channels) throw new Error("Speech WAV is missing format or sample data");
  return { mimeType: "audio/wav", durationMs: Math.round((dataLength / byteRate) * 1_000), sampleRate, channels };
};

export const createSilentWav = (durationMs: number, sampleRate = 24_000): Uint8Array => {
  const boundedDuration = Math.max(250, Math.min(120_000, Math.round(durationMs)));
  const sampleCount = Math.round((boundedDuration / 1_000) * sampleRate);
  const dataLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataLength, true);
  return bytes;
};

export const padPcmWavToDuration = (bytes: Uint8Array, minimumDurationMs: number): Uint8Array => {
  const metadata = inspectWav(bytes);
  const targetDurationMs = Math.max(metadata.durationMs, Math.min(120_000, Math.ceil(minimumDurationMs)));
  if (targetDurationMs <= metadata.durationMs) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let formatOffset = -1;
  let formatLength = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = resolvedWavChunkLength(type, view.getUint32(offset + 4, true), bytes.length - offset - 8);
    if (type === "fmt ") {
      formatOffset = offset + 8;
      formatLength = length;
    }
    if (type === "data") {
      dataOffset = offset + 8;
      dataLength = length;
      break;
    }
    offset += 8 + length + (length % 2);
  }
  if (formatOffset < 0 || formatLength < 16 || dataOffset < 0) throw new Error("Speech WAV cannot be normalized without PCM format and data chunks");
  const audioFormat = view.getUint16(formatOffset, true);
  const channels = view.getUint16(formatOffset + 2, true);
  const sampleRate = view.getUint32(formatOffset + 4, true);
  const byteRate = view.getUint32(formatOffset + 8, true);
  const blockAlign = view.getUint16(formatOffset + 12, true);
  const bitsPerSample = view.getUint16(formatOffset + 14, true);
  if (audioFormat !== 1 || !channels || !sampleRate || !byteRate || !blockAlign || !bitsPerSample) {
    throw new Error("Speech WAV normalization supports bounded PCM audio only");
  }
  const desiredBytes = Math.ceil((targetDurationMs / 1_000) * byteRate / blockAlign) * blockAlign;
  const padded = new Uint8Array(44 + desiredBytes);
  const paddedView = new DataView(padded.buffer);
  const write = (writeOffset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) padded[writeOffset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  paddedView.setUint32(4, 36 + desiredBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  paddedView.setUint32(16, 16, true);
  paddedView.setUint16(20, audioFormat, true);
  paddedView.setUint16(22, channels, true);
  paddedView.setUint32(24, sampleRate, true);
  paddedView.setUint32(28, byteRate, true);
  paddedView.setUint16(32, blockAlign, true);
  paddedView.setUint16(34, bitsPerSample, true);
  write(36, "data");
  paddedView.setUint32(40, desiredBytes, true);
  padded.set(bytes.subarray(dataOffset, dataOffset + dataLength), 44);
  return padded;
};
