// REN-05 / scripts/ren05-render-urls.mjs
// Composes the render-check URLs from seed.json. Kept in Node rather than in the PowerShell caller:
// the ids and query encoding come from one place, so no identifier is ever transcribed by hand.
import fs from "node:fs";
const seedPath = process.argv[2];
const port = process.argv[3] || "20005";
const outPath = process.argv[4];
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const bp = "/__openclaw__/video-assets/";
const video = seed.assets.find((a) => a.file === "clip_720p_2s.mp4");
const proxy = seed.derivations.find((d) => d.derivative_type === "proxy" && d.source_file === "clip_720p_2s.mp4");
const audio = seed.derivations.find((d) => d.derivative_type === "audio_proxy");
const thumb = seed.derivations.find((d) => d.derivative_type === "thumbnail" && d.source_file === "clip_720p_2s.mp4");
const make = (videoUrl) => `http://127.0.0.1:${port}/render-check?${new URLSearchParams({ video: videoUrl, audio: `${bp}proxy/${audio.derived_file_id}`, image: `${bp}thumb/${thumb.derived_file_id}` }).toString()}`;
const payload = {
  inline_url: make(`${bp}file/${video.asset_version_id}?disposition=inline`),
  proxy_url: make(`${bp}proxy/${proxy.derived_file_id}`),
  video_version_id: video.asset_version_id,
  video_size_bytes: video.size_bytes,
  proxy_derived_id: proxy.derived_file_id,
  audio_derived_id: audio.derived_file_id,
  thumbnail_derived_id: thumb.derived_file_id
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
