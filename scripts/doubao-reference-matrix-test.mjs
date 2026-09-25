#!/usr/bin/env node
// REN-09 父审修正 · 豆包参考资源 合法/拒绝 离线矩阵（零成本、零外部调用）
// 依据官方原文（https://docs.volcengine.com/docs/6561/2550782?lang=zh ，核查于 2026-09-20）：
//   · 最多 3 条参考音频，单条 ≤30s、≤10MB，格式 wav/mp3/pcm/ogg_opus
//   · 最多 1 张参考图片，≤10MB，格式 jpeg/png/webp
//   · 图片参考不能与音频参考混用（image_* 不得与 audio_* / speaker 同时传入）
//   · 每条参考内 speaker / audio_data / audio_url 互斥
//   · 参考音频上传顺序须与 text_prompt 中 @音频N 编号顺序严格对应
//   · 采样率逐格式：wav/pcm 含 40000；mp3 不含 40000；ogg_opus 仅 48000
// 本文件只做**离线结构判定**，不发起任何计费请求；负例一律离线构造。
// 父审第 2 项要求：不得把「3 音频 + 1 图片」当作正例（那是图文混用，属拒绝用例）。
import assert from "node:assert/strict";
import {
  normalizeDoubaoAudioRequest,
  validateDoubaoAudioRequest,
  DOUBAO_REFERENCE_LIMITS,
  DOUBAO_SAMPLE_RATES_BY_FORMAT
} from "../src/doubao-audio-adapter.js";

const failures = [];
const gate = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`FAIL ${name}: ${err?.message ?? err}`);
  }
};

const PLAIN_PROMPT = "0-3 秒平静钢琴前景；3-10 秒保持，后景留白。";
const REFERENCING_PROMPT = "0-3 秒，@音频1 起一段平静钢琴作为前景；3-10 秒保持。前景钢琴，中景无，后景留白。";
const base = { backend: "mock", prompt_text: PLAIN_PROMPT, char_limit: 3000, output_format: "wav", sample_rate: 24000 };

const check = (overrides) => {
  const request = normalizeDoubaoAudioRequest({ ...base, ...overrides });
  return { request, validation: validateDoubaoAudioRequest(request) };
};
const blockerText = (validation) => validation.blockers.join(" | ");
const small = (n = 8) => "A".repeat(n);
const oversize = () => "A".repeat(14000000); // base64 文本长度需 > 13981013 才能让解码体积超过 10MB

// ============================ 合法用例（正例） ============================
gate("M1 纯文本（无参考资源、无 @音频N 引用）合法", () => {
  const { validation } = check({});
  assert.equal(validation.status, "ready", blockerText(validation));
  assert.equal(validation.checks.audio_reference_count, 0);
  assert.equal(validation.checks.image_reference_count, 0);
  assert.deepEqual(validation.checks.referenced_audio_indices, []);
});

gate("M2 单条参考音频（内联 audio_data）合法", () => {
  const { validation } = check({ prompt_text: REFERENCING_PROMPT, references: [{ audio_data: small(64) }] });
  assert.equal(validation.status, "ready", blockerText(validation));
  assert.deepEqual(validation.checks.referenced_audio_indices, [1]);
  assert.equal(validation.checks.audio_reference_count, 1);
});

gate("M3 三条参考音频（官方上限）合法", () => {
  const { validation } = check({
    prompt_text: "0-5 秒，@音频1 前景；5-8 秒 @音频2 中景；8-12 秒 @音频3 后景。",
    references: [{ audio_data: small(64) }, { audio_url: "https://example.invalid/a2.wav" }, { speaker: "S_synthetic" }]
  });
  assert.equal(validation.status, "ready", blockerText(validation));
  assert.equal(validation.checks.audio_reference_count, 3);
  assert.deepEqual(validation.checks.referenced_audio_indices, [1, 2, 3]);
});

gate("M4 单张参考图片（不与音频混用）合法", () => {
  const { validation } = check({ references: [{ image_data: small(64) }] });
  assert.equal(validation.status, "ready", blockerText(validation));
  assert.equal(validation.checks.image_reference_count, 1);
  assert.equal(validation.checks.audio_reference_count, 0);
});

gate("M5 每条参考内 speaker / audio_data / audio_url 三选一均合法", () => {
  for (const reference of [{ speaker: "S_synthetic" }, { audio_data: small(32) }, { audio_url: "https://example.invalid/a.wav" }]) {
    const { validation } = check({ references: [reference] });
    assert.equal(validation.status, "ready", `${JSON.stringify(reference)} → ${blockerText(validation)}`);
  }
});

gate("M6 逐格式采样率：官方允许集内均合法", () => {
  for (const [format, rates] of Object.entries(DOUBAO_SAMPLE_RATES_BY_FORMAT)) {
    for (const rate of rates) {
      const request = normalizeDoubaoAudioRequest({ ...base, output_format: format, sample_rate: rate });
      const validation = validateDoubaoAudioRequest(request);
      assert.equal(validation.status, "ready", `${format}@${rate} → ${blockerText(validation)}`);
    }
  }
  assert.ok(DOUBAO_SAMPLE_RATES_BY_FORMAT.wav.includes(40000), "wav 必须接受官方默认 40000");
  assert.ok(DOUBAO_SAMPLE_RATES_BY_FORMAT.pcm.includes(40000), "pcm 必须接受官方默认 40000");
  assert.deepEqual([...DOUBAO_SAMPLE_RATES_BY_FORMAT.ogg_opus], [48000]);
  assert.equal(DOUBAO_SAMPLE_RATES_BY_FORMAT.mp3.includes(40000), false, "mp3 官方允许集不含 40000");
});

gate("M7 显式传入有据授权值时可登记为 cleared（授权不被强制抹平）", () => {
  const { request } = check({ license_status: "cleared", risk_level: "low" });
  assert.equal(request.asset_policy.license_status, "cleared");
  assert.equal(request.asset_policy.risk_level, "low");
  const defaulted = check({});
  assert.equal(defaulted.request.asset_policy.license_status, "unknown", "无依据时必须为 unknown");
  assert.equal(defaulted.request.asset_policy.risk_level, "unknown");
});

// ============================ 拒绝用例（负例，全部离线） ============================
gate("M8 四条参考音频被拒（音频上限 3）", () => {
  const { validation } = check({ references: [{ audio_data: small() }, { audio_data: small() }, { audio_data: small() }, { audio_data: small() }] });
  assert.equal(validation.status, "blocked");
  assert.match(blockerText(validation), /at most 3 audio references/);
});

gate("M9 两张参考图片被拒（图片上限 1）", () => {
  const { validation } = check({ references: [{ image_data: small() }, { image_data: small() }] });
  assert.equal(validation.status, "blocked");
  assert.match(blockerText(validation), /at most 1 image reference/);
});

gate("M10 图文混用被拒——「3 音频 + 1 图片」是拒绝用例而非正例", () => {
  const { validation } = check({
    references: [{ audio_data: small() }, { audio_data: small() }, { audio_data: small() }, { image_data: small() }]
  });
  assert.equal(validation.status, "blocked");
  assert.match(blockerText(validation), /audio and image references cannot be mixed/);
  // 父审第 2 项：blocked-verification 曾把这一组合写成正例，属自相矛盾，已改为本拒绝用例
});

gate("M11 单条参考内多字段被拒", () => {
  const { validation } = check({ references: [{ audio_data: small(), audio_url: "https://example.invalid/a.wav" }] });
  assert.equal(validation.status, "blocked");
  assert.match(blockerText(validation), /exactly one of speaker, audio_data, audio_url/);
});

gate("M12 内联参考超出 10MB 被拒（体积可离线判定）", () => {
  const { validation } = check({ references: [{ image_data: oversize() }] });
  assert.equal(validation.status, "blocked");
  assert.match(blockerText(validation), /decoded size .* exceeds 10485760 bytes/);
});

gate("M13 有参考音频时 @音频N 编号悬空被拒；无参考时降为提示（不误伤用途说明）", () => {
  const withOne = check({ prompt_text: "0-5 秒，@音频2 作为前景。", references: [{ audio_data: small() }] });
  assert.equal(withOne.validation.status, "blocked");
  assert.match(blockerText(withOne.validation), /references @音频2 but only 1 audio reference/);
  // 无参考音频时：既有文案常用「用于即梦视频 @音频1」说明用途，不应被当作悬空引用而拒绝
  const noReferences = check({ prompt_text: REFERENCING_PROMPT });
  assert.equal(noReferences.validation.status, "ready", blockerText(noReferences.validation));
  assert.deepEqual(noReferences.validation.checks.referenced_audio_indices, [1]);
  assert.ok(noReferences.validation.warnings.some((item) => item.includes("@音频N")));
});

gate("M14 采样率与格式不匹配被拒（mp3 不含 40000；ogg_opus 仅 48000）", () => {
  const mp3 = check({ output_format: "mp3", sample_rate: 40000 });
  assert.equal(mp3.validation.status, "blocked");
  assert.match(blockerText(mp3.validation), /sample_rate 40000 is not supported by output_format mp3/);
  const opus = check({ output_format: "ogg_opus", sample_rate: 24000 });
  assert.equal(opus.validation.status, "blocked");
  assert.match(blockerText(opus.validation), /sample_rate 24000 is not supported by output_format ogg_opus/);
});

gate("M15 被拒请求不得被标记为可执行（结构判定先于执行）", () => {
  const { request, validation } = check({ references: [{ image_data: oversize() }] });
  assert.equal(validation.status, "blocked");
  assert.equal(request.execution.execute, false, "被拒请求不得标记为执行");
  assert.equal(request.execution.accept_cost, false);
});

gate("M16 平台审核通过不构成授权依据（默认 unknown）", () => {
  const { request, validation } = check({ backend: "mock" });
  assert.equal(validation.status, "ready", blockerText(validation));
  assert.equal(validation.checks.platform_review_policy, "platform_review_passed_is_content_review_only");
  assert.equal(validation.checks.license_status_on_success, "unknown");
  assert.equal(validation.checks.risk_level_on_success, "unknown");
  assert.equal(request.asset_policy.license_status, "unknown");
});

if (failures.length) {
  console.error(`\ndoubao reference matrix test FAILED (${failures.length})`);
  for (const f of failures) console.error(` - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log("\ndoubao reference matrix test passed");
