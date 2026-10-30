/**
 * REN-11 local acceptance package builder.
 *
 * Produces the 15s / 3-shot / 1280x720 / 30fps H.264+AAC programme used as the zero-cost
 * acceptance render, entirely from FFmpeg synthetic sources plus one host font for text. The
 * output is an **engineering test preview**: nothing here is a generated-model sample and nothing
 * here is a final cut (see the `status` field in the returned manifest).
 */
import fs from "node:fs";
import path from "node:path";
import {
  REN11_FIXTURE_SPEC,
  REN11_SHOTS,
  burnSubtitles,
  concatShots,
  ensureScratchFont,
  ffprobeJson,
  generateDefectiveFixture,
  generateFixtureShot,
  muxSoftSubtitles,
  probeSummary,
  renderSrt,
  ren11CuePlan,
  sha256File
} from "./sop-v2-media.js";

export const FIXTURE_STATUS = Object.freeze({
  kind: "engineering_test_preview",
  statement: "本地原创程序化夹具的工程测试预览，不是生成模型样片，也不是最终成片。",
  license: "original_synthetic_no_third_party_media"
});

export async function buildLocalFixturePackage({
  workDir,
  outputDir,
  spec = REN11_FIXTURE_SPEC,
  filePrefix = "ren11-local-fixture-15s",
  buildDefective = true,
  ffmpegPath = null,
  ffprobePath = null,
  onStage = () => {}
} = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  // A build is a full regeneration: leftover scratch output from an interrupted earlier build must
  // not be able to stand in for a freshly rendered shot (that is how a stale file got concatenated).
  const shotsDir = path.join(workDir, "shots");
  fs.rmSync(shotsDir, { recursive: true, force: true });
  for (const entry of fs.readdirSync(workDir)) {
    if (/^(shot-\d+-?\d*\.mp4|concat-list\.txt|_.*)$/i.test(entry)) fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(shotsDir, { recursive: true });

  onStage({ stage: "shots", status: "start" });
  const font = await ensureScratchFont(workDir);
  const shots = [];
  for (const shot of REN11_SHOTS) {
    const target = path.join(shotsDir, `${shot.key}.mp4`);
    const fact = await generateFixtureShot({ shot, outputPath: target, workDir, spec, ffmpegPath });
    shots.push({ ...shot, file: fact });
  }
  onStage({ stage: "shots", status: "done", count: shots.length });

  onStage({ stage: "concat", status: "start" });
  const masterPath = path.join(workDir, `${filePrefix}-master.mp4`);
  const master = await concatShots({ shotPaths: shots.map((s) => s.file.path), outputPath: masterPath, workDir, ffmpegPath });
  onStage({ stage: "concat", status: "done" });

  onStage({ stage: "subtitles", status: "start" });
  const cues = ren11CuePlan(spec);
  const srtPath = path.join(workDir, `${filePrefix}.srt`);
  fs.writeFileSync(srtPath, renderSrt(cues), "utf8");
  const softPath = path.join(outputDir, `${filePrefix}-softsub.mp4`);
  const soft = await muxSoftSubtitles({ videoPath: masterPath, srtPath, outputPath: softPath, workDir, ffmpegPath });
  const burnedPath = path.join(outputDir, `${filePrefix}-burnedsub.mp4`);
  const burned = await burnSubtitles({ videoPath: masterPath, srtPath, outputPath: burnedPath, workDir, spec, ffmpegPath });
  onStage({ stage: "subtitles", status: "done" });

  let defective = null;
  if (buildDefective) {
    onStage({ stage: "defective_control", status: "start" });
    const defectivePath = path.join(outputDir, `${filePrefix}-DEFECTIVE-control.mp4`);
    defective = await generateDefectiveFixture({ outputPath: defectivePath, workDir, ffmpegPath });
    onStage({ stage: "defective_control", status: "done" });
  }

  const manifest = {
    schema: "ren11.fixture.manifest.v1",
    built_at: new Date().toISOString(),
    status: FIXTURE_STATUS,
    font: { copied_from: font.source, scratch_name: font.local, purpose: "text rasterisation only; not redistributed" },
    spec,
    cues,
    srt: { path: srtPath, sha256: await sha256File(srtPath) },
    shots: shots.map((shot) => ({
      index: shot.index,
      key: shot.key,
      label: shot.label,
      tone_hz: shot.tone_hz,
      background: shot.background,
      accent: shot.accent,
      motion: shot.motion,
      file: shot.file
    })),
    master: { ...master, probe: probeSummary(await ffprobeJson(master.path, { ffprobePath })) },
    deliverables: {
      soft_subtitle: { ...soft, probe: probeSummary(await ffprobeJson(soft.path, { ffprobePath })) },
      burned_subtitle: { ...burned, probe: probeSummary(await ffprobeJson(burned.path, { ffprobePath })) }
    },
    defective_control: defective
      ? { ...defective, probe: probeSummary(await ffprobeJson(defective.path, { ffprobePath })) }
      : null
  };
  const manifestPath = path.join(outputDir, `${filePrefix}-manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifest_path: manifestPath, work_dir: workDir, output_dir: outputDir };
}
