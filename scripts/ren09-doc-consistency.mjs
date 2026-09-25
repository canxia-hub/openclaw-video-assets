#!/usr/bin/env node
// REN-09 · 工程文档与候选仓库的事实一致性检查（父审第 4 项）
// 目的：文档里的 commit / 计数 / 证据条数一律以**实际目录与代码**为准，
// 不允许手写数字长期漂移。任何不一致直接非零退出。
//
// 统计口径（全部来自实际载体，不来自文档自述）：
//   · commit           ← git rev-parse HEAD（候选仓库）
//   · evidence 条数     ← capability-registry.js 的 EVIDENCE
//   · provider / 模型数 ← capability-registry.js
//   · check 项数        ← logs/<run>/results.json
//   · 日志文件数        ← logs/<run> 目录实际 *.log
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE,
  PROVIDER_REGISTRY,
  DREAMINA_VIDEO_MODEL_VALUES,
  DREAMINA_IMAGE_MODEL_VALUES,
  renderProviderModelMatrixMarkdown
} from "../src/capability-registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// 默认文档目录：插件仓库位于 <工程根>/repo/video-assets，因此上两级就是 <工程根>（即 implementation/REN-09）。
const DOC_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(REPO, "..", "..");
const RUN_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.join(DOC_DIR, "logs", "checks-final");

const facts = {
  commit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  branch: execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
  baseline_commit: "36a1c237fcb3ed54503a24e3a2739a66299c5bd8",
  evidence_count: Object.keys(EVIDENCE).length,
  provider_count: Object.keys(PROVIDER_REGISTRY).length,
  video_model_count: DREAMINA_VIDEO_MODEL_VALUES.length,
  image_model_count: DREAMINA_IMAGE_MODEL_VALUES.length,
  provider_model_count: Object.values(PROVIDER_REGISTRY).reduce((acc, provider) => acc + (provider.models?.length ?? 0), 0)
};

const problems = [];
const note = (message) => problems.push(message);

// ---------- 1. 候选仓库提交与文档引用一致 ----------
const shortCommit = facts.commit.slice(0, 7);
const isAncestorOrEqual = (candidate) => {
  if (!candidate) return false;
  if (candidate === facts.commit) return true;
  try {
    execFileSync("git", ["-C", REPO, "merge-base", "--is-ancestor", candidate, facts.commit], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
};
const resultsPath = path.join(RUN_DIR, "results.json");
if (!fs.existsSync(resultsPath)) {
  note(`missing run results: ${resultsPath}`);
}
let run = null;
if (fs.existsSync(resultsPath)) {
  run = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  facts.check_total = run.total;
  facts.check_passed = run.passed;
  facts.check_failed = run.failed;
  facts.check_log_files = fs.readdirSync(RUN_DIR).filter((name) => name.endsWith(".log")).length;
  // 全量跑在「已提交的代码」上进行；文档可能在之后追写，因此只要 run 的提交是 HEAD 或其祖先即可。
  if (!isAncestorOrEqual(run.repo_commit)) {
    note(`run results.json was produced at ${run.repo_commit.slice(0, 7)}, which is neither HEAD (${shortCommit}) nor an ancestor of it`);
  }
  facts.run_commit = run.repo_commit;
  if (facts.check_log_files !== run.total) {
    note(`expected ${run.total} check logs, found ${facts.check_log_files} in ${RUN_DIR}`);
  }
  if (run.failed !== 0) {
    note(`run has ${run.failed} failing check(s)`);
  }
  if (!run.worktree_clean_before_and_after) {
    note("run was not produced on a clean worktree; per-check results may not be reproducible from the commit alone");
  }
}
const acceptableCommits = new Set([facts.commit, shortCommit]);
if (run?.repo_commit) {
  acceptableCommits.add(run.repo_commit);
  acceptableCommits.add(run.repo_commit.slice(0, 7));
}

// ---------- 2. 文档不得引用过时提交 ----------
const docs = ["acceptance.md", "report.md", "README.md", "blocked-verification.md", "rollback.md", "cost-authorization-evidence.md"];
const knownStaleCommits = ["32dfa99", "6d7e3f8", "79f22e9", "4414054", "282b542"];
const HISTORY_MARKERS = /(历史|前序|上一|先前|沿革|父审所指|superseded|earlier)/;
// 运行目录名里嵌了提交短号（如 logs/checks-run2-79f22e9/），它们是**证据路径标签**而非「当前候选」声明，
// 因此按路径标签豁免；真正的 prose 引用仍需历史标记。
const RUN_LABEL_PATTERNS = /(logs[\\/]|checks-run|recheck-crash)/;
const commitMentioningDocs = new Set();
const exemptRunLabels = [];
for (const name of docs) {
  const file = path.join(DOC_DIR, name);
  if (!fs.existsSync(file)) {
    note(`missing document: ${name}`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const stale of knownStaleCommits) {
    if (stale === shortCommit || !text.includes(stale)) continue;
    // 含过时提交的**整行**必须带历史标记，或者是运行目录路径标签
    const offending = text
      .split(/\r?\n/)
      .filter((line) => line.includes(stale) && !HISTORY_MARKERS.test(line) && !RUN_LABEL_PATTERNS.test(line));
    if (offending.length) note(`${name} references stale commit ${stale} without a history marker (current: ${shortCommit})`);
    for (const line of text.split(/\r?\n/)) {
      if (line.includes(stale) && !HISTORY_MARKERS.test(line) && RUN_LABEL_PATTERNS.test(line)) exemptRunLabels.push({ file: name, stale });
    }
  }
  if ([...acceptableCommits].some((commit) => text.includes(commit))) commitMentioningDocs.add(name);
}
for (const required of ["acceptance.md", "report.md", "README.md", "rollback.md"]) {
  if (!commitMentioningDocs.has(required)) note(`${required} must state the current candidate commit ${shortCommit}`);
}

// ---------- 3. 证据条数：文档若给出数字，必须与注册表一致 ----------
const evidenceClaims = [
  { name: "acceptance.md", patterns: [/`?EVIDENCE`?\s*（?\s*(\d+)\s*条/, /证据\s*(\d+)\s*条/] }
];
for (const claim of evidenceClaims) {
  const file = path.join(DOC_DIR, claim.name);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of claim.patterns) {
    const match = text.match(pattern);
    if (match) {
      const claimed = Number(match[1]);
      if (claimed !== facts.evidence_count) note(`${claim.name} claims ${claimed} evidence entries but the registry has ${facts.evidence_count}`);
    }
  }
}

// ---------- 4. 派生矩阵必须与注册表投影一致 ----------
const matrixPath = path.join(DOC_DIR, "provider-model-matrix.md");
if (!fs.existsSync(matrixPath)) {
  note("missing provider-model-matrix.md");
} else {
  const onDisk = fs.readFileSync(matrixPath, "utf8").replace(/\r\n/g, "\n");
  const projected = renderProviderModelMatrixMarkdown().replace(/\r\n/g, "\n");
  if (onDisk !== projected) note("provider-model-matrix.md is out of sync with the registry projection (regenerate it)");
}

// ---------- 5. 文档中不得把已修正的旧口径当作当前事实陈述 ----------
// 说明：这些短语本身也可能出现在「解释修正」的行里（例如「禁用陈旧口径：运行时仍默认 cleared」）。
// 因此只对**不带修正标记**的行报错，并把跳过的行打印出来，保持透明不隐藏。
const FORBIDDEN_CLAIMS = [
  { pattern: /运行时(仍|依旧)[^\n]{0,20}cleared/, why: "运行时已不再把新产物默认标为 cleared" },
  { pattern: /3 音频 \+ 1 图片[^\n]{0,20}(正例|合法)/, why: "3 音频 + 1 图片属图文混用，必须是拒绝用例" },
  { pattern: /(唯一|已证实)根因[^\n]{0,10}内存/, why: "内存压力是待验证推断，不是已证根因" }
];
const CORRECTION_MARKERS = /(禁用陈旧口径|父审修正|修改前|修改后|不得|禁止|已改|不再是|待验证推断)/;
const skippedExplanatoryLines = [];
for (const name of docs) {
  const file = path.join(DOC_DIR, name);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of FORBIDDEN_CLAIMS) {
      if (!rule.pattern.test(line)) continue;
      if (CORRECTION_MARKERS.test(line)) {
        skippedExplanatoryLines.push({ file: name, line: index + 1, why: rule.why });
        continue;
      }
      note(`${name}:${index + 1} states a corrected claim as current fact (${rule.why})`);
    }
  });
}

// ---------- 输出 ----------
console.log(JSON.stringify({ doc_dir: DOC_DIR, run_dir: RUN_DIR, facts, skipped_explanatory_lines: skippedExplanatoryLines.length, exempt_run_labels: exemptRunLabels }, null, 2));
if (problems.length) {
  console.error(`\ndoc consistency check FAILED (${problems.length})`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("\ndoc consistency check passed");
