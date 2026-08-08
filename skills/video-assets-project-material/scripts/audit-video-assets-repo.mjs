import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_REPO = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".openclaw-video-assets");
const repoRoot = process.argv.find((arg) => arg.startsWith("--repo="))?.slice("--repo=".length) ?? DEFAULT_REPO;
const cardsRoot = process.argv.find((arg) => arg.startsWith("--cards-root="))?.slice("--cards-root=".length) ?? null;
const dbPath = path.join(repoRoot, "metadata", "video-assets.sqlite");
const strict = process.argv.includes("--strict");

const hasChinese = /[\u3400-\u9fff]/;
const testKeyword = /\b(test|smoke|probe|validation|phase\s*[a-z0-9-]*|live\s+validation|metadata\s+verification)\b/i;
const materialExt = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".psd", ".clip",
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
  ".wav", ".mp3", ".aac", ".flac", ".m4a",
  ".srt", ".ass", ".vtt", ".json", ".yaml", ".yml"
]);
const infoCardNames = new Set(["素材信息卡.md", "INFO.md", "info.md", "Info.md"]);

function issue(level, code, target, message) {
  return { level, code, target, message };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function count(db, table, where = "") {
  if (!tableExists(db, table)) return 0;
  return Number(db.prepare("SELECT COUNT(*) AS count FROM " + table + where).get()?.count ?? 0);
}

function listFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir, rel = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(absolute, relative);
      else files.push({ relative_path: relative, size_bytes: fs.statSync(absolute).size });
    }
  };
  walk(root);
  return files;
}

function auditInfoCards(root) {
  const findings = [];
  if (!root) return findings;
  if (!fs.existsSync(root)) {
    findings.push(issue("error", "CARDS_ROOT_MISSING", root, "信息卡检查根目录不存在"));
    return findings;
  }
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    const dirs = entries.filter((entry) => entry.isDirectory());
    const hasMaterial = files.some((entry) => materialExt.has(path.extname(entry.name).toLowerCase()));
    const hasInfoCard = files.some((entry) => infoCardNames.has(entry.name) || entry.name.toLowerCase().endsWith(".info.md"));
    if (hasMaterial && !hasInfoCard) {
      findings.push(issue("error", "ASSET_FOLDER_MISSING_INFO_CARD", dir, "资产文件夹包含素材文件但缺少 素材信息卡.md / INFO.md / *.info.md"));
    }
    if (hasInfoCard) {
      const card = files.find((entry) => infoCardNames.has(entry.name) || entry.name.toLowerCase().endsWith(".info.md"));
      const cardPath = path.join(dir, card.name);
      const text = fs.readFileSync(cardPath, "utf8");
      for (const required of ["基本信息", "来源与授权", "使用规则"]) {
        if (!text.includes(required)) {
          findings.push(issue("warning", "INFO_CARD_MISSING_SECTION", cardPath, "信息卡缺少章节：" + required));
        }
      }
    }
    for (const child of dirs) walk(path.join(dir, child.name));
  };
  walk(root);
  return findings;
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

if (!fs.existsSync(dbPath)) {
  console.error(JSON.stringify({ ok: false, error: "metadata database not found: " + dbPath }, null, 2));
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const issues = [];

const projects = tableExists(db, "projects")
  ? db.prepare("SELECT project_id, title, status, description FROM projects WHERE status != 'archived' ORDER BY updated_at DESC").all()
  : [];

for (const project of projects) {
  if (!hasChinese.test(project.title ?? "")) {
    issues.push(issue("error", "PROJECT_TITLE_NOT_CHINESE", project.project_id, "项目标题不是中文：" + project.title));
  }
  if (testKeyword.test(project.title ?? "") || testKeyword.test(project.description ?? "")) {
    issues.push(issue("error", "PROJECT_TEST_NAME_VISIBLE", project.project_id, "active 项目仍含开发测试命名：" + project.title));
  }
}

const assets = tableExists(db, "assets")
  ? db.prepare("SELECT asset_id, title, media_type, lifecycle FROM assets WHERE lifecycle NOT IN ('archived', 'soft_deleted') ORDER BY updated_at DESC").all()
  : [];

for (const asset of assets) {
  if (!hasChinese.test(asset.title ?? "")) {
    issues.push(issue("error", "ASSET_TITLE_NOT_CHINESE", asset.asset_id, "资产标题不是中文：" + asset.title));
  }
  if (testKeyword.test(asset.title ?? "")) {
    issues.push(issue("error", "ASSET_TEST_NAME_VISIBLE", asset.asset_id, "active 资产仍含开发测试命名：" + asset.title));
  }
  const classifications = count(db, "asset_classifications", " WHERE asset_id = " + sqlString(asset.asset_id));
  if (strict && classifications === 0) {
    issues.push(issue("warning", "ASSET_MISSING_TAXONOMY", asset.asset_id, "资产缺少 taxonomy：" + asset.title));
  }
}

const stagingFiles = listFiles(path.join(repoRoot, "asset-repo", "staging"));
for (const file of stagingFiles) {
  if (testKeyword.test(file.relative_path)) {
    issues.push(issue("error", "STAGING_TEST_FILE_VISIBLE", file.relative_path, "暂存区仍有开发测试文件"));
  }
  if (!hasChinese.test(file.relative_path)) {
    issues.push(issue("warning", "STAGING_FILE_NOT_CHINESE", file.relative_path, "暂存区文件名不是中文；确认入库前应改为中文标题或中文文件名"));
  }
}

issues.push(...auditInfoCards(cardsRoot));

const summary = {
  repoRoot,
  cardsRoot,
  counts: {
    projects: projects.length,
    assets: assets.length,
    project_refs: count(db, "project_references", " WHERE status != 'removed'"),
    derived_files: count(db, "derived_files", " WHERE status = 'active'"),
    staging_files: stagingFiles.length,
    commits: count(db, "commits")
  },
  issues,
  ok: issues.every((item) => item.level !== "error")
};

db.close();

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);
