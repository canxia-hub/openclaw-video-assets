import fs from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".psd", ".psb"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".opus"]);
const PACKAGE_EXTENSIONS = new Set([".zip", ".7z", ".rar"]);
const TEXT_EXTENSIONS = new Set([".json", ".srt", ".vtt", ".xml", ".fcpxml", ".txt", ".md"]);

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".bmp", "image/bmp"],
  [".psd", "image/vnd.adobe.photoshop"],
  [".psb", "image/vnd.adobe.photoshop"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
  [".m4v", "video/x-m4v"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".aac", "audio/aac"],
  [".m4a", "audio/mp4"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".zip", "application/zip"],
  [".json", "application/json"],
  [".srt", "text/plain"],
  [".vtt", "text/vtt"],
  [".xml", "application/xml"],
  [".fcpxml", "application/xml"],
  [".txt", "text/plain"],
  [".md", "text/markdown"]
]);

export function probeMedia(filePath, options = {}) {
  const namedPath = options.file_name || options.fileName || filePath;
  const extension = path.extname(namedPath).toLowerCase();
  const mime_type = (options.mime_type || options.mimeType || MIME_BY_EXTENSION.get(extension)) ?? "application/octet-stream";
  const container = extension ? extension.slice(1) : undefined;
  const base = { extension, mime_type, container };

  if (IMAGE_EXTENSIONS.has(extension)) {
    return { ...base, media_type: "image", format_family: "raster", ...probeImage(filePath, extension) };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { ...base, media_type: "video", format_family: "video", ...probeVideo(filePath, extension) };
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return { ...base, media_type: "audio", format_family: "audio", ...probeAudio(filePath, extension) };
  }
  if (PACKAGE_EXTENSIONS.has(extension)) {
    return { ...base, media_type: "package", format_family: "archive" };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { ...base, media_type: "document", format_family: "text" };
  }
  return { ...base, media_type: "other", format_family: "unknown" };
}

function probeImage(filePath, extension) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (extension === ".png") return pngDimensions(buffer);
    if (extension === ".jpg" || extension === ".jpeg") return jpegDimensions(buffer);
    if (extension === ".webp") return webpDimensions(buffer);
  } catch {
    return {};
  }
  return {};
}

function probeVideo(filePath, extension) {
  if (![".mp4", ".mov", ".m4v"].includes(extension)) return {};
  try {
    return probeIsoBmffVideo(fs.readFileSync(filePath));
  } catch {
    return {};
  }
}

function probeAudio(filePath, extension) {
  if (extension !== ".wav") return {};
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return {};
    const sample_rate = buffer.readUInt32LE(24);
    const channels = buffer.readUInt16LE(22);
    const byteRate = buffer.readUInt32LE(28);
    const dataOffset = findChunk(buffer, "data");
    const dataBytes = dataOffset >= 0 ? buffer.readUInt32LE(dataOffset + 4) : undefined;
    const duration_ms = dataBytes && byteRate ? Math.round((dataBytes / byteRate) * 1000) : undefined;
    return clean({ sample_rate, channels, duration_ms, codec: "pcm" });
  } catch {
    return {};
  }
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return {};
  return clean({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), codec: "png" });
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return {};
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return clean({ height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), codec: "jpeg" });
    }
    offset += 2 + length;
  }
  return {};
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return {};
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X" && buffer.length >= 30) {
    return clean({ width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), codec: "webp" });
  }
  if (type === "VP8 " && buffer.length >= 30) {
    return clean({ width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, codec: "webp" });
  }
  return { codec: "webp" };
}

function probeIsoBmffVideo(buffer) {
  const moov = findBox(buffer, 0, buffer.length, "moov");
  if (!moov) return {};
  for (const trak of findBoxes(buffer, moov.contentStart, moov.end, "trak")) {
    const mdia = findBox(buffer, trak.contentStart, trak.end, "mdia");
    if (!mdia || handlerType(buffer, mdia) !== "vide") continue;
    const tkhd = findBox(buffer, trak.contentStart, trak.end, "tkhd");
    const stbl = findNestedBox(buffer, mdia, ["minf", "stbl"]);
    const mdhd = findBox(buffer, mdia.contentStart, mdia.end, "mdhd");
    const size = tkhd ? trackDimensions(buffer, tkhd) : {};
    const timing = mdhd ? mediaTiming(buffer, mdhd) : {};
    const samples = stbl ? sampleCountAndDuration(buffer, stbl) : {};
    return clean({
      ...size,
      duration_ms: timing.durationSeconds ? Math.round(timing.durationSeconds * 1000) : undefined,
      frame_rate: frameRateFromSamples(samples.sampleCount, timing.durationSeconds),
      codec: stbl ? videoCodec(buffer, stbl) : undefined
    });
  }
  return {};
}

function findNestedBox(buffer, parent, types) {
  let current = parent;
  for (const type of types) {
    current = findBox(buffer, current.contentStart, current.end, type);
    if (!current) return undefined;
  }
  return current;
}

function findBox(buffer, start, end, type) {
  return findBoxes(buffer, start, end, type)[0];
}

function findBoxes(buffer, start, end, type) {
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    const header = readBoxHeader(buffer, offset, end);
    if (!header) break;
    if (header.type === type) boxes.push(header);
    offset = header.end;
  }
  return boxes;
}

function readBoxHeader(buffer, offset, boundary) {
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > boundary) return undefined;
    size = Number(buffer.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size32 === 0) {
    size = boundary - offset;
  }
  if (!Number.isFinite(size) || size < headerSize || offset + size > boundary) return undefined;
  return { type, start: offset, contentStart: offset + headerSize, end: offset + size };
}

function handlerType(buffer, mdia) {
  const hdlr = findBox(buffer, mdia.contentStart, mdia.end, "hdlr");
  return hdlr && hdlr.contentStart + 12 <= hdlr.end ? buffer.toString("ascii", hdlr.contentStart + 8, hdlr.contentStart + 12) : undefined;
}

function trackDimensions(buffer, tkhd) {
  const version = buffer[tkhd.contentStart];
  const widthOffset = tkhd.contentStart + (version === 1 ? 92 : 76);
  if (widthOffset + 8 > tkhd.end) return {};
  return clean({
    width: fixed16(buffer.readUInt32BE(widthOffset)),
    height: fixed16(buffer.readUInt32BE(widthOffset + 4))
  });
}

function mediaTiming(buffer, mdhd) {
  const version = buffer[mdhd.contentStart];
  const timescaleOffset = mdhd.contentStart + (version === 1 ? 20 : 12);
  const durationOffset = mdhd.contentStart + (version === 1 ? 24 : 16);
  if (durationOffset + (version === 1 ? 8 : 4) > mdhd.end) return {};
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const duration = version === 1 ? Number(buffer.readBigUInt64BE(durationOffset)) : buffer.readUInt32BE(durationOffset);
  return { timescale, duration, durationSeconds: timescale > 0 && duration > 0 ? duration / timescale : undefined };
}

function sampleCountAndDuration(buffer, stbl) {
  const stts = findBox(buffer, stbl.contentStart, stbl.end, "stts");
  if (stts && stts.contentStart + 8 <= stts.end) {
    const entries = buffer.readUInt32BE(stts.contentStart + 4);
    let offset = stts.contentStart + 8;
    let sampleCount = 0;
    let sampleDuration = 0;
    for (let i = 0; i < entries && offset + 8 <= stts.end; i += 1, offset += 8) {
      const count = buffer.readUInt32BE(offset);
      const delta = buffer.readUInt32BE(offset + 4);
      sampleCount += count;
      sampleDuration += count * delta;
    }
    return { sampleCount, sampleDuration };
  }
  const stsz = findBox(buffer, stbl.contentStart, stbl.end, "stsz");
  return stsz && stsz.contentStart + 12 <= stsz.end ? { sampleCount: buffer.readUInt32BE(stsz.contentStart + 8) } : {};
}

function videoCodec(buffer, stbl) {
  const stsd = findBox(buffer, stbl.contentStart, stbl.end, "stsd");
  if (!stsd || stsd.contentStart + 16 > stsd.end || buffer.readUInt32BE(stsd.contentStart + 4) < 1) return undefined;
  const codec = buffer.toString("ascii", stsd.contentStart + 12, stsd.contentStart + 16);
  const mapped = new Map([["avc1", "h264"], ["avc3", "h264"], ["hvc1", "hevc"], ["hev1", "hevc"], ["vp09", "vp9"], ["mp4v", "mpeg4"]]);
  return mapped.get(codec) ?? codec.trim() ?? undefined;
}

function fixed16(value) {
  const number = value / 65536;
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function frameRateFromSamples(sampleCount, durationSeconds) {
  if (!Number.isFinite(sampleCount) || !Number.isFinite(durationSeconds) || sampleCount <= 0 || durationSeconds <= 0) return undefined;
  return Math.round((sampleCount / durationSeconds) * 1000) / 1000;
}

function findChunk(buffer, name) {
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunk === name) return offset;
    offset += 8 + size + (size % 2);
  }
  return -1;
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== 0 && item !== ""));
}
