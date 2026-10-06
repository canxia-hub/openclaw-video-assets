import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { storeObject } from "./storage.js";
import { withTrustedContext, trustedContextOf } from "./provider-gateway.js";
import { CompatError } from "./sdk-compat.js";
import { createEpub } from "./narrative-export.js";
import { NarrativeModelJobs } from "./narrative-model.js";

const uid = (prefix) => prefix + "_" + randomUUID().replaceAll("-", "");
const now = () => new Date().toISOString();
const parse = (value, fallback = []) => value ? JSON.parse(value) : fallback;
export { NARRATIVE_KINDS, novelError } from "./narrative-common.js";
import { NARRATIVE_KINDS, novelError } from "./narrative-common.js";
const requireText = (value, label, max = 500000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw novelError("INVALID_INPUT", label + "不能为空，且不能超过" + max + "字符");
  return value;
};
const integer = (value, fallback = 0) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 1000000) throw novelError("INVALID_INPUT", "顺序或分页参数无效");
  return result;
};

export const NARRATIVE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS novel_documents (document_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, volume_order INTEGER NOT NULL DEFAULT 0, chapter_order INTEGER NOT NULL DEFAULT 0, asset_id TEXT NOT NULL, head_revision_id TEXT, approved_revision_id TEXT, needs_review INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,document_key))",
  "CREATE TABLE IF NOT EXISTS novel_revisions (revision_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, asset_version_id TEXT NOT NULL UNIQUE, parent_revision_id TEXT, snapshot_id TEXT, dependencies_json TEXT NOT NULL DEFAULT '[]', change_summary TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS novel_snapshots (snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_ids_json TEXT NOT NULL, resources_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS novel_reviews (review_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, reviewer TEXT NOT NULL, findings_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS novel_exports (export_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_ids_json TEXT NOT NULL, assets_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS novel_documents_project ON novel_documents(project_id,kind,volume_order,chapter_order)",
  "CREATE INDEX IF NOT EXISTS novel_revisions_document ON novel_revisions(document_id,created_at)"
].join(";\n") + ";";

export class NarrativeService {
  constructor(service, { modelAdapter = null } = {}) {
    this.host = service;
    this.db = service.db;
    this.db.exec(NARRATIVE_SCHEMA);
    this.jobs = new NarrativeModelJobs(this, { adapter: modelAdapter });
  }

  actor(input) {
    const a = this.host.resolveRequestActor(input);
    return this.host.ensureActor(a.actor_id, a.actor_type);
  }
  project(input) {
    requireText(input.project_id, "project_id", 200);
    try { return this.host.requireProject(input.project_id); }
    catch { throw novelError("PROJECT_NOT_FOUND", "项目不存在", 404); }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  documentRow(input) {
    this.project(input);
    const row = input.document_id
      ? this.db.prepare("SELECT * FROM novel_documents WHERE document_id=? AND project_id=?").get(input.document_id, input.project_id)
      : this.db.prepare("SELECT * FROM novel_documents WHERE document_key=? AND project_id=?").get(input.document_key, input.project_id);
    if (!row) throw novelError("DOCUMENT_NOT_FOUND", "项目内未找到文档", 404);
    return row;
  }
  revision(input, revisionId) {
    this.project(input);
    const row = this.db.prepare("SELECT r.*,d.project_id,d.kind,d.title,d.document_key,d.approved_revision_id,d.head_revision_id,d.needs_review FROM novel_revisions r JOIN novel_documents d ON d.document_id=r.document_id WHERE r.revision_id=? AND d.project_id=?").get(revisionId, input.project_id);
    if (!row) throw novelError("CROSS_PROJECT_REFERENCE", "版本不存在或不属于本项目", 404);
    return { ...row, dependencies: parse(row.dependencies_json) };
  }
  readRevision(input, revisionId) {
    const r = this.revision(input, revisionId);
    const file = this.host.resolveVersionFile(r.asset_version_id);
    return { ...r, body: fs.readFileSync(file.file_path, "utf8") };
  }
  human(input) {
    const c = trustedContextOf(input);
    const allowed = c?.trusted && ["browser", "gateway"].includes(c.surface) &&
      (c.scopes?.includes("operator.write") || c.scopes?.includes("operator.admin"));
    if (!allowed) throw novelError("HUMAN_APPROVAL_REQUIRED", "审定必须从已认证的人类工作台或操作员接口提交", 403);
  }
  audit(input, action, target, changes = {}) {
    const actor = this.actor(input);
    this.host.commit({ scope: "project", target_id: target, action, message: action, actor_id: actor.actor_id, changes });
  }

  async prepareObject(body, suffix = ".md") {
    const dir = path.join(this.host.root, "asset-repo", "staging", "narrative");
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, uid("staged") + suffix);
    fs.writeFileSync(filename, body);
    try { return await storeObject(this.host.root, filename); }
    finally { fs.unlinkSync(filename); } // only this disposable staging file, never a registered asset
  }

  // Objects are immutable and written first. ALL asset metadata, taxonomy, project ref and narrative
  // pointers are then committed in ONE SQLite transaction. A failed transaction may leave an
  // unreferenced content-addressed blob, never an approved-but-unregistered revision.
  registerObject(input, stored, { assetId = uid("asset"), parentVersion = null, title, suffix = ".md", mime = "text/markdown", changeSummary = "叙事文档版本", sourceVersions = [], role = "script" } = {}) {
    const versionId = uid("ver"), time = now(), actor = this.actor(input);
    const existing = this.host.getAssetRow(assetId);
    if (!existing) {
      this.db.prepare("INSERT INTO assets (asset_id,kind,media_type,format_family,title,description,lifecycle,default_version_id,root_asset_id,tags_json,created_by,created_at,updated_at) VALUES (?,'working','document','text',?,?,'active',?,?,'[\"narrative\"]',?,?,?)")
        .run(assetId, title, "小说—动画叙事域", versionId, assetId, actor.actor_id, time, time);
    }
    this.db.prepare("INSERT INTO asset_versions (asset_version_id,asset_id,version_label,object_id,file_name,extension,mime_type,size_bytes,sha256,change_summary,parent_version_id,source_version_ids_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(versionId, assetId, "v" + String(this.db.prepare("SELECT count(*) n FROM asset_versions WHERE asset_id=?").get(assetId).n + 1).padStart(3,"0"), stored.object_id, assetId + suffix, suffix.slice(1), mime, stored.size_bytes, stored.sha256, changeSummary, parentVersion, JSON.stringify(sourceVersions), actor.actor_id, time);
    this.db.prepare("UPDATE assets SET default_version_id=?,updated_at=? WHERE asset_id=?").run(versionId, time, assetId);
    const ref = this.db.prepare("SELECT reference_id FROM project_references WHERE project_id=? AND asset_id=? AND status!='removed'").get(input.project_id,assetId);
    if (!ref) this.db.prepare("INSERT INTO project_references (reference_id,project_id,asset_id,asset_version_id,role,pin_mode,required,added_by,added_at,updated_at,notes) VALUES (?,?,?,?,?,'candidate',1,?,?,?,?)")
      .run(uid("ref"), input.project_id, assetId, versionId, role, actor.actor_id,time,time,"叙事草稿；审定后固定版本");
    this.db.prepare("INSERT INTO asset_classifications (classification_id,asset_id,asset_version_id,domain,type,confidence,source,created_by,created_at,updated_at) VALUES (?,?,?,'document','narrative','confirmed','agent',?,?,?)")
      .run(uid("cls"),assetId,versionId,actor.actor_id,time,time);
    this.db.prepare("INSERT INTO asset_annotations (annotation_id,target_type,target_id,annotation_type,title,body,visibility,created_by,created_at,updated_at) VALUES (?,'asset_version',?,'production_note',?,?,'internal',?,?,?)")
      .run(uid("ann"), versionId, "叙事素材信息卡", JSON.stringify({ project_id: input.project_id, source: "narrative-service", status:"draft", license_status:"unknown", version_id:versionId, change_summary:changeSummary }),actor.actor_id,time,time);
    this.audit(input, "novel.asset.register", input.project_id, {asset_id:assetId,asset_version_id:versionId});
    return {asset_id:assetId,asset_version_id:versionId,sha256:stored.sha256};
  }

  async document(input) {
    const op = input.op ?? "list";
    this.project(input);
    if (op === "list") return this.db.prepare("SELECT * FROM novel_documents WHERE project_id=? ORDER BY volume_order,chapter_order,created_at,document_id LIMIT ? OFFSET ?")
      .all(input.project_id, Math.min(integer(input.limit,200),1000), integer(input.offset));
    if (op === "save") return this.save(input);
    if (op === "approve" || op === "reject") return this.approve(input, op);
    const d = this.documentRow(input);
    if (op === "get") { const r=d.head_revision_id ? this.readRevision(input,input.revision_id ?? d.head_revision_id) : null; if(r && r.document_id!==d.document_id)throw novelError("INVALID_REVISION","版本不属于文档");return {...d,revision:r}; }
    if (op === "history") return this.db.prepare("SELECT * FROM novel_revisions WHERE document_id=? ORDER BY created_at,rowid").all(d.document_id);
    if (op === "diff") {
      const old = this.readRevision(input,input.from_revision_id ?? d.approved_revision_id ?? d.head_revision_id);
      const next = this.readRevision(input,input.to_revision_id ?? d.head_revision_id);
      if (old.document_id !== d.document_id || next.document_id !== d.document_id) throw novelError("INVALID_REVISION","差异版本不属于文档");
      return { from_revision_id:old.revision_id,to_revision_id:next.revision_id,changed:old.body !== next.body,before:old.body,after:next.body };
    }
    throw novelError("INVALID_OPERATION","未知文档操作");
  }

  async save(input, jobCommit = null) {
    this.project(input);
    const key = requireText(input.document_key ?? (input.document_id ? this.documentRow(input).document_key : null),"document_key",200);
    const title = requireText(input.title,"title",300), body = requireText(input.body,"body");
    if (!NARRATIVE_KINDS.includes(input.kind)) throw novelError("INVALID_KIND","未知叙事文档类型");
    if (!Object.hasOwn(input,"expected_head")) throw novelError("EXPECTED_HEAD_REQUIRED","保存必须提供 expected_head；首次保存为 null",409);
    const before = this.db.prepare("SELECT * FROM novel_documents WHERE project_id=? AND document_key=?").get(input.project_id,key);
    if (input.document_id && input.document_id !== before?.document_id) throw novelError("DOCUMENT_NOT_FOUND","文档标识不匹配",404);
    const deps = input.dependencies ?? [];
    if (!Array.isArray(deps) || deps.length > 1000 || new Set(deps).size !== deps.length) throw novelError("INVALID_DEPENDENCIES","依赖必须是不重复的版本列表");
    deps.forEach(id => this.revision(input,id));
    if (input.snapshot_id) this.snapshot(input,input.snapshot_id);
    const stored = await this.prepareObject(body);
    return this.tx(() => {
      const d = this.db.prepare("SELECT * FROM novel_documents WHERE project_id=? AND document_key=?").get(input.project_id,key);
      if ((d?.head_revision_id ?? null) !== input.expected_head) throw novelError("HEAD_CONFLICT","文档已被修改，请重新读取后保存",409,{actual_head:d?.head_revision_id ?? null});
      if (d && d.kind !== input.kind) throw novelError("KIND_CONFLICT","既有文档不能改变类型");
      if (input.snapshot_id && !this.snapshotCurrent(input,input.snapshot_id)) throw novelError("STALE_SNAPSHOT","设定快照已过期，请重新组装上下文",409);
      const docId = d?.document_id ?? uid("noveldoc"), revisionId = uid("novelrev"), time = now();
      const parentVersion = d ? this.revision(input,d.head_revision_id).asset_version_id : null;
      const registered = this.registerObject(input,stored,{assetId:d?.asset_id, parentVersion,title,changeSummary:input.change_summary ?? "保存叙事草稿",sourceVersions:deps.map(id=>this.revision(input,id).asset_version_id)});
      if (!d) this.db.prepare("INSERT INTO novel_documents (document_id,project_id,document_key,kind,title,volume_order,chapter_order,asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(docId,input.project_id,key,input.kind,title,integer(input.volume_order),integer(input.chapter_order),registered.asset_id,time,time);
      this.db.prepare("INSERT INTO novel_revisions (revision_id,document_id,asset_version_id,parent_revision_id,snapshot_id,dependencies_json,change_summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(revisionId,docId,registered.asset_version_id,d?.head_revision_id ?? null,input.snapshot_id ?? null,JSON.stringify(deps),input.change_summary ?? "保存草稿",this.actor(input).actor_id,time);
      this.db.prepare("UPDATE novel_documents SET title=?,volume_order=?,chapter_order=?,head_revision_id=?,updated_at=? WHERE document_id=?")
        .run(title,integer(input.volume_order,d?.volume_order ?? 0),integer(input.chapter_order,d?.chapter_order ?? 0),revisionId,time,docId);
      this.audit(input,"novel.document.save",input.project_id,{document_id:docId,revision_id:revisionId});
      const saved={document_id:docId,revision_id:revisionId,head_revision_id:revisionId,...registered,approved:false};
      if(jobCommit){const changes=this.db.prepare("UPDATE novel_jobs SET state=\'succeeded\',result_json=?,updated_at=? WHERE job_id=? AND state=\'ready\'").run(JSON.stringify({...jobCommit.result,saved}),time,jobCommit.jobId).changes;if(changes!==1)throw novelError("JOB_NOT_READY","模型任务已提交或取消",409);}
      return saved;
    });
  }

  approve(input, op) {
    this.human(input);
    return this.tx(() => {
      const d = this.documentRow(input), r = this.revision(input,input.revision_id ?? d.head_revision_id);
      if (r.document_id !== d.document_id || r.revision_id !== d.head_revision_id || input.expected_head !== d.head_revision_id) throw novelError("HEAD_CONFLICT","只能审定当前文档头版本",409);
      if (op === "reject") {
        this.db.prepare("UPDATE novel_documents SET needs_review=1,updated_at=? WHERE document_id=?").run(now(),d.document_id);
        this.audit(input,"novel.document.reject",input.project_id,{revision_id:r.revision_id});
        return {document_id:d.document_id,approved_revision_id:d.approved_revision_id,needs_review:true};
      }
      if (r.snapshot_id && !this.snapshotCurrent(input,r.snapshot_id)) throw novelError("STALE_SNAPSHOT","输入设定已变更，需复查",409);
      for (const id of r.dependencies) {
        const dep = this.revision(input,id);
        if (dep.approved_revision_id !== id || dep.needs_review) throw novelError("DEPENDENCY_NOT_APPROVED","依赖版本未审定或需复查",409);
      }
      const impacted = d.approved_revision_id && d.approved_revision_id !== r.revision_id ? this.impact(input,d.approved_revision_id) : {documents:[],exports:[]};
      for (const other of impacted.documents) this.db.prepare("UPDATE novel_documents SET needs_review=1 WHERE document_id=?").run(other.document_id);
      this.db.prepare("UPDATE novel_documents SET approved_revision_id=?,needs_review=0,updated_at=? WHERE document_id=?").run(r.revision_id,now(),d.document_id);
      this.db.prepare("UPDATE project_references SET asset_version_id=?,pin_mode='pinned',notes='叙事审定版本',updated_at=? WHERE project_id=? AND asset_id=? AND status!='removed'").run(r.asset_version_id,now(),input.project_id,d.asset_id);
      this.audit(input,"novel.document.approve",input.project_id,{revision_id:r.revision_id,impacted});
      return {document_id:d.document_id,approved_revision_id:r.revision_id,impacted};
    });
  }

  impact(input, revisionId) {
    this.revision(input,revisionId);
    const documents = [], affected = new Set([revisionId]);
    const rows = this.db.prepare("SELECT d.*,r.dependencies_json,r.snapshot_id FROM novel_documents d JOIN novel_revisions r ON r.revision_id=d.head_revision_id WHERE d.project_id=?").all(input.project_id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of rows) {
        if (documents.some(x=>x.document_id === d.document_id)) continue;
        const snapshot = d.snapshot_id ? this.snapshot(input,d.snapshot_id) : null;
        if ([...parse(d.dependencies_json),...(snapshot?.revision_ids ?? [])].some(id=>affected.has(id))) {
          documents.push({document_id:d.document_id,title:d.title,kind:d.kind,head_revision_id:d.head_revision_id});
          affected.add(d.head_revision_id); if (d.approved_revision_id) affected.add(d.approved_revision_id); changed = true;
        }
      }
    }
    const exports = this.db.prepare("SELECT * FROM novel_exports WHERE project_id=?").all(input.project_id).filter(e=>parse(e.revision_ids_json).some(id=>affected.has(id)));
    return {revision_id:revisionId,documents,exports:exports.map(e=>({export_id:e.export_id,immutable:true})),history_unchanged:true};
  }
  snapshot(input, snapshotId) {
    const s = this.db.prepare("SELECT * FROM novel_snapshots WHERE snapshot_id=? AND project_id=?").get(snapshotId,input.project_id);
    if (!s) throw novelError("CROSS_PROJECT_REFERENCE","快照不属于项目",404);
    return {...s,revision_ids:parse(s.revision_ids_json),resources:parse(s.resources_json)};
  }
  snapshotCurrent(input, snapshotId) {
    const s = this.snapshot(input,snapshotId);
    const current=this.db.prepare("SELECT approved_revision_id FROM novel_documents WHERE project_id=? AND approved_revision_id IS NOT NULL AND kind IN (\'bible\',\'character\',\'timeline\',\'foreshadow\',\'volume\')").all(input.project_id).map(d=>d.approved_revision_id);
    return current.length===s.revision_ids.length && current.every(id=>s.revision_ids.includes(id)) && s.revision_ids.every(id=>{ const r=this.revision(input,id);return r.approved_revision_id === id && !r.needs_review; }) &&
      s.resources.every(res=>this.db.prepare("SELECT 1 FROM project_references WHERE reference_id=? AND project_id=? AND asset_version_id=? AND status!='removed'").get(res.reference_id,input.project_id,res.asset_version_id));
  }
  sources(input) {
    return this.host.listProjectRefs(input).map(ref=>{
      const version = this.host.getVersionRow(ref.asset_version_id), asset = this.host.getAssetRow(ref.asset_id);
      return {...ref,title:asset?.title,media_type:asset?.media_type,license_status:asset?.license_status,
        sha256:version?.sha256, observation_status: "reference-not-canon",
        text:version && ["md","txt","json","csv"].includes(version.extension) && version.size_bytes <= 200000 ? fs.readFileSync(this.host.resolveVersionFile(version.asset_version_id).file_path,"utf8") : null};
    });
  }
  context(input) {
    this.project(input);
    const docs = this.db.prepare("SELECT * FROM novel_documents WHERE project_id=? AND approved_revision_id IS NOT NULL AND kind IN ('bible','character','timeline','foreshadow','volume') ORDER BY kind,volume_order,document_id").all(input.project_id);
    if (!docs.some(d=>d.kind === "bible")) throw novelError("CANON_REQUIRED","需要至少一份已审定的共享设定",409);
    if (docs.some(d=>d.needs_review)) throw novelError("REVIEW_REQUIRED","共享设定存在需复查文档",409);
    const mandatory = docs.map(d=>this.readRevision(input,d.approved_revision_id));
    const maxChars = Math.min(integer(input.max_chars,80000),500000);
    const used = mandatory.reduce((n,r)=>n+r.body.length,0);
    if (used > maxChars) throw novelError("MANDATORY_CONTEXT_TOO_LARGE","必需设定超出上下文上限；不会静默截断",409,{characters:used,max_chars:maxChars});
    const sourceIds = input.reference_ids ?? [];
    if (!Array.isArray(sourceIds) || sourceIds.length > 200) throw novelError("INVALID_INPUT","reference_ids 无效");
    const sources = this.sources(input);
    const selected = sourceIds.map(id=>{const ref=sources.find(r=>r.reference_id===id);if(!ref)throw novelError("CROSS_PROJECT_REFERENCE","资源引用不属于项目",404);return ref;});
    const requiredSize = used + selected.reduce((n,s)=>n+(s.text?.length ?? 0),0);
    if(requiredSize > maxChars) throw novelError("MANDATORY_CONTEXT_TOO_LARGE","已选资料超出上限，请减少资源或提高字符预算",409);
    const snapshotId=uid("novelsnap"), actor=this.actor(input);
    this.db.prepare("INSERT INTO novel_snapshots (snapshot_id,project_id,revision_ids_json,resources_json,created_by,created_at) VALUES (?,?,?,?,?,?)")
      .run(snapshotId,input.project_id,JSON.stringify(mandatory.map(r=>r.revision_id)),JSON.stringify(selected.map(r=>({reference_id:r.reference_id,asset_version_id:r.asset_version_id,sha256:r.sha256}))),actor.actor_id,now());
    this.audit(input,"novel.context.create",input.project_id,{snapshot_id:snapshotId});
    return {snapshot_id:snapshotId,project_id:input.project_id,canon:mandatory,resources:selected,characters:requiredSize,unit:"characters-not-tokens",warnings:selected.filter(r=>r.license_status!=="cleared").map(r=>({code:"LICENSE_UNKNOWN",reference_id:r.reference_id}))};
  }
  contextFromSnapshot(input,snapshotId) {
    const s=this.snapshot(input,snapshotId);
    return {snapshot:s,canon:s.revision_ids.map(id=>this.readRevision(input,id)),resources:s.resources.map(r=>({...r,file:this.host.resolveVersionFile(r.asset_version_id)}))};
  }

  async workflow(input) {
    this.project(input);
    switch (input.op) {
      case "context": return this.context(input);
      case "sources": return this.sources(input);
      case "snapshot": return this.contextFromSnapshot(input,input.snapshot_id);
      case "impact": return this.impact(input,input.revision_id ?? this.documentRow(input).approved_revision_id);
      case "review": {
        const r=this.revision(input,input.revision_id);
        if (!Array.isArray(input.findings) || JSON.stringify(input.findings).length > 50000) throw novelError("INVALID_INPUT","findings 必须是有限审稿记录列表");
        const reviewId=uid("novelreview");
        this.db.prepare("INSERT INTO novel_reviews VALUES (?,?,?,?,?,?)").run(reviewId,input.project_id,r.revision_id,this.actor(input).actor_id,JSON.stringify(input.findings),now());
        this.audit(input,"novel.review.record",input.project_id,{review_id:reviewId,revision_id:r.revision_id});
        return {review_id:reviewId,revision_id:r.revision_id,findings:input.findings,quality_evaluated:false};
      }
      case "reviews": return this.db.prepare("SELECT * FROM novel_reviews WHERE project_id=? AND revision_id=? ORDER BY created_at").all(input.project_id,input.revision_id);
      case "export": return this.export(input);
      case "exports": return this.db.prepare("SELECT * FROM novel_exports WHERE project_id=? ORDER BY created_at DESC").all(input.project_id);
      default: throw novelError("INVALID_OPERATION","未知工作流操作");
    }
  }

  async export(input) {
    const project=this.project(input);
    const requested=input.revision_ids ?? this.db.prepare("SELECT approved_revision_id FROM novel_documents WHERE project_id=? AND kind='chapter' AND approved_revision_id IS NOT NULL ORDER BY volume_order,chapter_order,document_id").all(input.project_id).map(d=>d.approved_revision_id);
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > 1000) throw novelError("CHAPTERS_REQUIRED","需要已审定章节才能导出");
    const revisions=requested.map(id=>this.readRevision(input,id));
    if(revisions.some(r=>r.kind!=="chapter" || r.approved_revision_id!==r.revision_id || r.needs_review)) throw novelError("APPROVED_CHAPTER_REQUIRED","只能导出已审定且无复查标记的章节",409);
    const format=input.format ?? "md";
    if(!["md","txt","epub"].includes(format))throw novelError("INVALID_FORMAT","支持 MD / TXT / EPUB");
    const body=format==="epub" ? createEpub({title:project.title,chapters:revisions}) :
      revisions.map((r,i)=>(format==="md"?"## ":"")+(i+1)+". "+r.title+"\n\n"+r.body).join("\n\n");
    const stored=await this.prepareObject(body,"."+format);
    return this.tx(()=>{
      for(const r of revisions){const current=this.revision(input,r.revision_id);if(current.approved_revision_id!==r.revision_id || current.needs_review)throw novelError("HEAD_CONFLICT","导出期间章节状态已变化",409);}
      const asset=this.registerObject(input,stored,{title:project.title+" · 小说导出",suffix:"."+format,mime:format==="epub"?"application/epub+zip":format==="txt"?"text/plain":"text/markdown",role:"delivery",changeSummary:"固定已审定章节导出",sourceVersions:revisions.map(r=>r.asset_version_id)});
      this.db.prepare("UPDATE project_references SET pin_mode='pinned' WHERE project_id=? AND asset_id=?").run(input.project_id,asset.asset_id);
      const exportId=uid("novelexport");
      this.db.prepare("INSERT INTO novel_exports VALUES (?,?,?,?,?)").run(exportId,input.project_id,JSON.stringify(requested),JSON.stringify([asset]),now());
      this.audit(input,"novel.export",input.project_id,{export_id:exportId,format,revision_ids:requested});
      return {export_id:exportId,format,...asset,revision_ids:requested,chapters:revisions.map(r=>({title:r.title,revision_id:r.revision_id,asset_version_id:r.asset_version_id})),download_path:"/file/"+asset.asset_version_id};
    });
  }
  async adaptation(input) {
    this.project(input);
    if (input.op==="save") {
      if (!input.chapter_revision_id || !input.snapshot_id) throw novelError("SNAPSHOT_REQUIRED","动画映射必须固定章节与设定快照",409);
      const chapter=this.revision(input,input.chapter_revision_id);
      if(chapter.kind!=="chapter" || chapter.approved_revision_id!==chapter.revision_id || chapter.needs_review)throw novelError("APPROVED_CHAPTER_REQUIRED","映射源必须是审定章节",409);
      const fields=["scene_goal","motivation","causality","emotion","boundaries","visible_action","dialogue"];
      const payload=input.mapping;
      if(!payload || typeof payload!=="object" || fields.some(f=>typeof payload[f]!=="string" || !payload[f].trim()))throw novelError("INVALID_MAPPING","映射缺少场次目标、动机、因果、情绪、边界、动作或对白");
      const snap=this.snapshot(input,input.snapshot_id);
      return this.save(withTrustedContext({...input,kind:"adaptation",body:JSON.stringify({chapter_revision_id:chapter.revision_id,snapshot_id:snap.snapshot_id,...payload},null,2),dependencies:[chapter.revision_id,...snap.revision_ids]},trustedContextOf(input)));
    }
    const d=this.documentRow(input), r=this.readRevision(input,input.revision_id ?? d.head_revision_id);
    if(d.kind!=="adaptation")throw novelError("INVALID_KIND","该文档不是动画映射");
    const mapping=parse(r.body,{});
    const stale=d.needs_review || !r.snapshot_id || !this.snapshotCurrent(input,r.snapshot_id) || r.dependencies.some(id=>{const dep=this.revision(input,id);return dep.approved_revision_id!==id || dep.needs_review;});
    if(input.op==="handoff" && (stale || d.approved_revision_id!==r.revision_id))throw novelError("ADAPTATION_NOT_APPROVED","交接须使用审定且未过期的动画映射",409);
    if(!["get","lint","handoff"].includes(input.op))throw novelError("INVALID_OPERATION","未知映射操作");
    return {project_id:input.project_id,document_id:d.document_id,revision_id:r.revision_id,asset_version_id:r.asset_version_id,mapping,ready:!stale && d.approved_revision_id===r.revision_id,issues:stale?["DEPENDENCIES_REQUIRE_REVIEW"]:[],... (input.op==="handoff"?{canon:this.snapshot(input,r.snapshot_id),source_chapter:this.revision(input,mapping.chapter_revision_id)}:{})};
  }
}
