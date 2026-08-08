import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const SHA256_OBJECT_ID = /^sha256:([a-f0-9]{64})$/;

export function resolveRepositoryRoot(pluginConfig = {}) {
  const configured = typeof pluginConfig.repositoryRoot === "string" ? pluginConfig.repositoryRoot.trim() : "";
  if (configured) return path.resolve(expandHome(configured));
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, ".openclaw-video-assets");
}

const REPOSITORY_DIRS = [
  "asset-repo/objects/sha256",
  "asset-repo/staging/uploads",
  "asset-repo/raw",
  "asset-repo/working",
  "asset-repo/derived",
  "asset-repo/archive",
  "project-repo/active",
  "project-repo/archived",
  "metadata",
  "events",
  "cache/thumbnails",
  "cache/proxies",
  "cache/search-index"
];

export function ensureRepositoryLayoutSync(root) {
  for (const dir of REPOSITORY_DIRS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

export async function ensureRepositoryLayout(root) {
  await Promise.all(REPOSITORY_DIRS.map((dir) => fs.promises.mkdir(path.join(root, dir), { recursive: true })));
}

export function getObjectPath(root, objectId) {
  const match = String(objectId).match(SHA256_OBJECT_ID);
  if (!match) throw new Error("invalid object id");
  const sha256 = match[1];
  return path.join(root, "asset-repo", "objects", "sha256", sha256.slice(0, 2), `${sha256}.blob`);
}

export async function storeObject(root, filePath) {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

  const sha256 = await hashFile(absolutePath);
  const objectDir = path.join(root, "asset-repo", "objects", "sha256", sha256.slice(0, 2));
  const objectPath = path.join(objectDir, `${sha256}.blob`);
  await fs.promises.mkdir(objectDir, { recursive: true });

  if (!fs.existsSync(objectPath)) {
    await pipeline(fs.createReadStream(absolutePath), fs.createWriteStream(objectPath, { flags: "wx" }));
  }

  return {
    object_id: `sha256:${sha256}`,
    object_path: objectPath,
    sha256,
    size_bytes: stat.size,
    file_name: path.basename(absolutePath)
  };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function expandHome(value) {
  if (value === "~") return process.env.USERPROFILE || process.env.HOME || value;
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(process.env.USERPROFILE || process.env.HOME || "~", value.slice(2));
  }
  return value;
}
