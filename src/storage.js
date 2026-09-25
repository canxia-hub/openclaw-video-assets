import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const SHA256_OBJECT_ID = /^sha256:([a-f0-9]{64})$/;

export function resolveRepositoryRoot(pluginConfig = {}) {
  // 存储后端对插件透明：本函数只决定根目录路径，对象读写全部走标准 fs。
  // 若需云端对象存储（COS/OSS/S3/R2/MinIO 等），用 rclone 磁盘模式挂载后
  // 将 asset-repo/objects 替换为指向挂载盘的 Junction/symlink 即可，无需改代码；
  // metadata/ 与 cache/ 必须留在本地磁盘。详见 README「云端对象存储接入」。
  const configured = typeof pluginConfig.repositoryRoot === "string" ? pluginConfig.repositoryRoot.trim() : "";
  if (configured) return path.resolve(expandHome(configured));
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, ".openclaw-video-assets");
}

const REPOSITORY_DIRS = [
  // asset-repo/objects 是体积大头（SHA-256 内容寻址 blob），可整体替换为
  // 指向云端挂载盘的 Junction/symlink；其余目录（尤其 SQLite 所在的 metadata/）
  // 不要放网络盘，有锁损坏风险。挂载勿用 --network-mode（Junction 会失效）。
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

/**
 * Raised when a content-addressed object already exists but its bytes do not match its own address.
 *
 * The object is deliberately NOT rewritten: overwriting a corrupt blob in place would destroy the
 * only copy of whatever is actually there before the incident has been reviewed. The caller fails,
 * records the mismatch, and leaves the object for a separate, explicitly-gated repair step.
 */
export class ObjectIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ObjectIntegrityError";
    this.code = "OBJECT_INTEGRITY_MISMATCH";
    this.details = details;
  }
}

/**
 * Store a file under its SHA-256 address.
 *
 * EXISTING-OBJECT POLICY (REN-05)
 * ------------------------------
 * The accepted baseline treated "a file is already at that path" as success:
 *
 *     if (!fs.existsSync(objectPath)) { ...write... }
 *
 * Content addressing makes that assumption load-bearing, and it is not safe. A 0-byte file, or a
 * file of exactly the right length holding wrong bytes, sits at the address of a hash it does not
 * have. Because the address was never re-checked, the ingest reported success, the database
 * recorded that hash as the version's identity, and every later reader comparing "declared hash vs
 * row" agreed with itself while the bytes on disk were wrong. `integrityScan({deep:true})` only
 * catches it later, and only if someone runs it.
 *
 * So an existing object is now VERIFIED, not assumed:
 *   * healthy (same size AND same SHA-256) -> success, state "already_healthy", nothing rewritten
 *   * anything else                        -> ObjectIntegrityError, nothing written, nothing deleted
 *
 * Because storeObject is the single write chokepoint shared by ingestAsset, createVersion and
 * registerDerivedFile, a refusal here happens before any row is inserted: no version is added, no
 * default version is switched, and the original object is left exactly as it was.
 */
export async function storeObject(root, filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

  const sha256 = await hashFile(absolutePath);
  const objectDir = path.join(root, "asset-repo", "objects", "sha256", sha256.slice(0, 2));
  const objectPath = path.join(objectDir, `${sha256}.blob`);
  await fs.promises.mkdir(objectDir, { recursive: true });

  const existing = await fs.promises.stat(objectPath).catch(() => null);
  if (existing) {
    const verdict = await verifyExistingObject(objectPath, { expectedSha256: sha256, expectedSize: stat.size });
    if (verdict.healthy) {
      return {
        object_id: `sha256:${sha256}`,
        object_path: objectPath,
        sha256,
        size_bytes: stat.size,
        file_name: path.basename(absolutePath),
        storage_state: "already_healthy",
        existing_bytes: existing.size
      };
    }
    throw new ObjectIntegrityError(
      `object ${objectPath} exists but does not match its content address (${verdict.reason})`,
      {
        object_id: `sha256:${sha256}`,
        object_path: objectPath,
        expected_sha256: sha256,
        expected_size_bytes: stat.size,
        actual_size_bytes: existing.size,
        actual_sha256: verdict.actual_sha256,
        reason: verdict.reason,
        source_file: absolutePath
      }
    );
  }

  try {
    await pipeline(fs.createReadStream(absolutePath), fs.createWriteStream(objectPath, { flags: "wx" }));
  } catch (error) {
    // Another writer won the race, or the write failed. Either way do not report success on an
    // unverified file: re-run the same verification the existing-object path uses.
    if (error?.code === "EEXIST") {
      const verdict = await verifyExistingObject(objectPath, { expectedSha256: sha256, expectedSize: stat.size });
      if (verdict.healthy) {
        return {
          object_id: `sha256:${sha256}`,
          object_path: objectPath,
          sha256,
          size_bytes: stat.size,
          file_name: path.basename(absolutePath),
          storage_state: "already_healthy"
        };
      }
      throw new ObjectIntegrityError(`object appeared during write and does not match its content address (${verdict.reason})`, {
        object_id: `sha256:${sha256}`,
        object_path: objectPath,
        expected_sha256: sha256,
        expected_size_bytes: stat.size,
        actual_size_bytes: verdict.actual_size,
        actual_sha256: verdict.actual_sha256,
        reason: verdict.reason
      });
    }
    await fs.promises.rm(objectPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    object_id: `sha256:${sha256}`,
    object_path: objectPath,
    sha256,
    size_bytes: stat.size,
    file_name: path.basename(absolutePath),
    storage_state: "written"
  };
}

/**
 * Check an existing object against the address it claims. Zero-byte objects are reported as their
 * own reason so the failure is legible without reading the numbers.
 */
export async function verifyExistingObject(objectPath, { expectedSha256, expectedSize }) {
  const stat = await fs.promises.stat(objectPath).catch(() => null);
  if (!stat || !stat.isFile()) return { healthy: false, reason: "object-missing", actual_size: stat?.size ?? null, actual_sha256: null };
  if (stat.size === 0) return { healthy: false, reason: "object-is-zero-bytes", actual_size: 0, actual_sha256: null };
  if (stat.size !== expectedSize) {
    return { healthy: false, reason: "size-mismatch", actual_size: stat.size, actual_sha256: null };
  }
  const actualSha = await hashFile(objectPath);
  if (actualSha !== expectedSha256) {
    return { healthy: false, reason: "equal-length-wrong-hash", actual_size: stat.size, actual_sha256: actualSha };
  }
  return { healthy: true, reason: "hash-and-size-match", actual_size: stat.size, actual_sha256: actualSha };
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
