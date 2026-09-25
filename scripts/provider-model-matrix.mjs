#!/usr/bin/env node
// REN-09 · 由能力注册表派生 provider-model-matrix.md
// 用法：node scripts/provider-model-matrix.mjs [--out <path>] [--check <path>]
//   --out    写出派生矩阵
//   --check  与磁盘既有文件比对（不一致则非零退出，用于漂移门）
import fs from "node:fs";
import path from "node:path";
import { renderProviderModelMatrixMarkdown, CAPABILITY_REGISTRY_SCHEMA_VERSION, PROVIDER_REGISTRY, EVIDENCE } from "../src/capability-registry.js";

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const md = renderProviderModelMatrixMarkdown();
const out = valueOf("--out");
const check = valueOf("--check");

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), md, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(out), bytes: Buffer.byteLength(md, "utf8"), schema: CAPABILITY_REGISTRY_SCHEMA_VERSION }));
} else if (check) {
  const target = path.resolve(check);
  const onDisk = fs.readFileSync(target, "utf8");
  const normalize = (s) => s.replace(/\r\n/g, "\n");
  if (normalize(onDisk) !== normalize(md)) {
    console.error(`DRIFT: ${target} does not match the registry projection`);
    process.exit(1);
  }
  console.log(JSON.stringify({ check: target, status: "in-sync", bytes: Buffer.byteLength(md, "utf8") }));
} else {
  process.stdout.write(md);
}

if (process.env.REN09_MATRIX_SUMMARY === "1") {
  const modelCount = Object.keys(PROVIDER_REGISTRY).reduce((acc, id) => acc + (PROVIDER_REGISTRY[id].models?.length ?? 0), 0);
  console.error(JSON.stringify({ providers: Object.keys(PROVIDER_REGISTRY).length, provider_models: modelCount, evidence: Object.keys(EVIDENCE).length }));
}
