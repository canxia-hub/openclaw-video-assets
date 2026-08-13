import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  rpc,
  mediaUrl,
  type AssetSummary,
  type AssetVersion,
  type CanvasEdge,
  type CanvasShape,
  type ProjectDetail,
  type ProjectIssue,
} from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { Badge, Field, fmtBytes, fmtTime, licenseBadge, riskBadge } from "./ui";

interface AssetDetail extends AssetSummary {
  versions?: AssetVersion[];
  branches?: { branch_id: string; name?: string }[];
  sources?: { source_id: string; source_type?: string; url?: string }[];
}

function QueryState({ isLoading, isError, error }: { isLoading: boolean; isError: boolean; error: unknown }) {
  if (isLoading) return <div className="py-6 text-center text-xs text-text-faint">加载中…</div>;
  if (isError)
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
        {error instanceof Error ? error.message : "加载失败"}
      </div>
    );
  return null;
}

const PRODUCTION_ROLE_LABELS: Record<string, string> = {
  generation_slot: "生成槽",
  generated_output: "生成输出",
  revision_output: "修订输出",
  replacement_output: "替换输出",
  timeline_output: "时间线输出",
  revision_card: "返修卡",
  project_ref: "项目引用",
  production_stage: "生产分区",
};

const RELATION_LABELS: Record<string, string> = {
  uses: "使用",
  depends_on: "依赖",
  references: "参考",
  derived_from: "派生自",
  revises: "修订",
  replaces: "替换",
  continues: "延续",
  belongs_to: "归属",
  appears_in: "出场",
  blocks: "阻塞",
  contains: "包含",
  related_to: "相关",
};

const SEMANTIC_LABELS: Record<string, string> = {
  reviewed_by: "由返修卡审阅",
  revision: "修订关系",
  replacement: "替换关系",
  timeline_append: "时间线追加",
  insert: "生成写入",
};

function productionRoleLabel(value: unknown) {
  const key = typeof value === "string" ? value : "";
  return PRODUCTION_ROLE_LABELS[key] ?? key;
}

function relationLabel(value: string) {
  return RELATION_LABELS[value] ?? value;
}

function uniqueProjectIssues(items: ProjectIssue[]) {
  const seen = new Set<string>();
  return items.filter((issue) => {
    const key = [issue.level, issue.code, issue.reference_id, issue.asset_id, issue.message].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function AssetInspector({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["asset.get", id],
    queryFn: () => rpc<AssetDetail>("asset.get", { asset_id: id }),
  });

  const state = QueryState(q);
  if (state) return state;
  const a = q.data;
  if (!a) return null;

  const lic = licenseBadge(a.license_status);
  const risk = riskBadge(a.risk_level);
  const defaultVer = a.versions?.find((v) => v.asset_version_id === a.default_version_id);
  const isImage = a.media_type === "image";

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-text-primary">{a.title || a.asset_id}</div>
        <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{a.asset_id}</div>
      </div>

      {isImage && a.default_version_id && (
        <img
          src={mediaUrl.thumb(a.default_version_id)}
          alt={a.title ?? ""}
          className="w-full rounded-md border border-border-subtle object-cover"
        />
      )}

      <div className="flex flex-wrap gap-1.5">
        <Badge label={lic.label} cls={lic.cls} />
        <Badge label={risk.label} cls={risk.cls} />
        {a.kind && <Badge label={a.kind} cls="text-text-secondary border-border-subtle" />}
        {a.media_type && <Badge label={a.media_type} cls="text-accent border-accent/40 bg-accent-dim" />}
      </div>

      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
        <Field label="生命周期">{a.lifecycle ?? "—"}</Field>
        <Field label="格式族">{a.format_family ?? "—"}</Field>
        <Field label="更新">{fmtTime(a.updated_at)}</Field>
        <Field label="创建">{fmtTime(a.created_at)}</Field>
      </div>

      {a.tags && a.tags.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-text-faint">标签</div>
          <div className="flex flex-wrap gap-1">
            {a.tags.slice(0, 12).map((t) => (
              <span key={t} className="rounded bg-bg-raise2 px-1.5 py-0.5 text-[10px] text-text-secondary">
                {t}
              </span>
            ))}
            {a.tags.length > 12 && <span className="text-[10px] text-text-faint">+{a.tags.length - 12}</span>}
          </div>
        </div>
      )}

      {a.versions && a.versions.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-text-faint">版本（{a.versions.length}）</div>
          <div className="space-y-1.5">
            {a.versions.map((v) => (
              <div
                key={v.asset_version_id}
                className={`rounded-md border px-2.5 py-2 text-[11px] ${
                  v.asset_version_id === a.default_version_id
                    ? "border-accent/40 bg-accent-dim"
                    : "border-border-subtle bg-bg-raise2"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">{v.version_label ?? v.asset_version_id.slice(0, 12)}</span>
                  <span className="text-text-faint">{fmtBytes(v.size_bytes)}</span>
                </div>
                <div className="mt-0.5 break-all text-text-secondary">{v.file_name ?? "—"}</div>
                <div className="mt-0.5 text-text-faint">
                  {v.mime_type ?? "—"}
                  {v.width && v.height ? ` · ${v.width}×${v.height}` : ""}
                  {v.duration_seconds ? ` · ${v.duration_seconds.toFixed(1)}s` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
        <Field label="分支">{a.branches?.length ?? 0}</Field>
        <Field label="来源记录">{a.sources?.length ?? 0}</Field>
        {defaultVer && <Field label="默认版本">{defaultVer.version_label ?? "—"}</Field>}
      </div>
    </div>
  );
}

/** 画布卡片检查器：直接渲染传入的 shape 数据，可跳转到关联资产/项目。 */
export function ShapeInspector({ shape }: { shape: CanvasShape }) {
  const select = useInspector((s) => s.select);
  const navigate = useNavigate();
  let props: Record<string, unknown> = shape.props ?? {};
  if (!shape.props && (shape as unknown as { props_json?: string }).props_json) {
    try {
      props = JSON.parse((shape as unknown as { props_json: string }).props_json);
    } catch {
      props = {};
    }
  }
  const propsText = JSON.stringify(props, null, 2);
  const subjectId = shape.subject_id;
  const productionRole = productionRoleLabel(props.role);
  const annotations = shape.subject_context?.annotation_summary?.details ?? [];
  const linkedAssetId = shape.subject_context?.asset?.asset_id
    ?? (typeof props.asset_id === "string" ? props.asset_id : null)
    ?? (shape.subject_type === "asset" ? subjectId : null);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-text-primary">{shape.title || shape.shape_id}</div>
        <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{shape.shape_id}</div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {productionRole && <Badge label={productionRole} cls="text-accent border-accent/40 bg-accent-dim" />}
        <Badge label={`技术类型：${shape.shape_type}`} cls="text-text-secondary border-border-subtle" />
        {shape.subject_type && <Badge label={`主体：${shape.subject_type}`} cls="text-text-secondary border-border-subtle" />}
      </div>

      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
        <Field label="主体">{subjectId ?? "—"}</Field>
        <Field label="位置">{Math.round(shape.x ?? 0)}, {Math.round(shape.y ?? 0)}</Field>
        <Field label="尺寸">
          {shape.width ?? "—"} × {shape.height ?? "—"}
        </Field>
        <Field label="层级">{shape.z_index ?? 0}</Field>
      </div>

      {annotations.length > 0 && (
        <div data-testid="shape-annotation-summary">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-faint">
            <span>审片与制作批注</span>
            <span>{annotations.length} 条</span>
          </div>
          <div className="space-y-2">
            {annotations.map((annotation) => (
              <div key={annotation.annotation_id} className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[11px]">
                <div className="font-medium text-text-primary">{annotation.title || "未命名批注"}</div>
                {annotation.body && <div className="mt-1 whitespace-pre-wrap leading-5 text-text-secondary">{annotation.body}</div>}
                {annotation.structured?.requested_change && (
                  <div className="mt-1 text-warning">处置要求：{String(annotation.structured.requested_change)}</div>
                )}
                <div className="mt-1 break-all font-mono text-[10px] text-text-faint">{annotation.annotation_id}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(props).length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-text-faint">属性</div>
          <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-bg-raise2 p-2 text-[10px] leading-4 text-text-secondary">
            {propsText}
          </pre>
        </div>
      )}

      {linkedAssetId && (
        <button
          onClick={() => {
            select({ kind: "asset", id: linkedAssetId });
            navigate(`/assets/${linkedAssetId}`);
          }}
          className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          查看关联资产
        </button>
      )}
      {shape.subject_type === "project" && subjectId && (
        <button
          onClick={() => {
            select({ kind: "project", id: subjectId });
            navigate(`/projects/${subjectId}`);
          }}
          className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          查看关联项目
        </button>
      )}
    </div>
  );
}

export function EdgeInspector({ edge, source, target }: { edge: CanvasEdge; source?: CanvasShape; target?: CanvasShape }) {
  const select = useInspector((s) => s.select);
  const semantic = typeof edge.props?.semantic === "string" ? edge.props.semantic : null;
  const historicalLabel = Boolean(edge.label && /[A-Za-z]/.test(edge.label));

  return (
    <div className="space-y-4" data-testid="edge-inspector">
      <div>
        <div className="text-sm font-medium text-text-primary">{edge.label || relationLabel(edge.relation_type)}</div>
        <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{edge.edge_id}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge label={relationLabel(edge.relation_type)} cls="text-accent border-accent/40 bg-accent-dim" />
        {semantic && <Badge label={SEMANTIC_LABELS[semantic] ?? semantic} cls="text-success border-success/40 bg-success/10" />}
        {historicalLabel && <Badge label="历史标签 · 待迁移" cls="text-warn border-warn/40 bg-warn/10" />}
      </div>
      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
        <Field label="关系类型">{edge.relation_type}</Field>
        <Field label="语义">{semantic ?? "未标记"}</Field>
        <Field label="来源">{source?.title ?? edge.source_shape_id}</Field>
        <Field label="目标">{target?.title ?? edge.target_shape_id}</Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          disabled={!source}
          onClick={() => source && select({ kind: "shape", id: source.shape_id, shape: source })}
          className="rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          定位来源
        </button>
        <button
          disabled={!target}
          onClick={() => target && select({ kind: "shape", id: target.shape_id, shape: target })}
          className="rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          定位目标
        </button>
      </div>
      {Object.keys(edge.props ?? {}).length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-bg-raise2 p-2 text-[10px] leading-4 text-text-secondary">
          {JSON.stringify(edge.props, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ProjectInspector({ id }: { id: string }) {
  const select = useInspector((s) => s.select);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["project.get", id],
    queryFn: () => rpc<ProjectDetail>("project.get", { project_id: id }),
  });

  const state = QueryState(q);
  if (state) return state;
  const p = q.data;
  if (!p) return null;
  const issues = uniqueProjectIssues([
    ...(p.report?.issues ?? []),
    ...(p.report?.warnings ?? []),
    ...(p.continuity?.issues ?? []),
    ...(p.continuity?.errors ?? []),
    ...(p.continuity?.warnings ?? []),
  ]);

  const locateIssue = (issue: ProjectIssue) => {
    const assetId = issue.asset_id ?? p.refs?.find((ref) => ref.reference_id === issue.reference_id)?.asset_id;
    if (!assetId) return;
    select({ kind: "asset", id: assetId });
    navigate(`/assets/${assetId}`);
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-text-primary">{p.title || p.project_id}</div>
        <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{p.project_id}</div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge label={p.status ?? "—"} cls="text-accent border-accent/40 bg-accent-dim" />
        {(p.error_count ?? 0) > 0 ? (
          <Badge label={`${p.error_count} 错误`} cls="text-danger border-danger/40 bg-danger/10" />
        ) : (
          <Badge label="无错误" cls="text-success border-success/40 bg-success/10" />
        )}
        {(p.warning_count ?? 0) > 0 && (
          <Badge label={`${p.warning_count} 警告`} cls="text-warn border-warn/40 bg-warn/10" />
        )}
      </div>

      {p.description && <p className="text-[11px] leading-5 text-text-secondary">{p.description}</p>}

      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
        <Field label="引用数">{p.ref_count ?? p.refs?.length ?? 0}</Field>
        <Field label="画幅">{p.aspect_ratio ?? "—"}</Field>
        <Field label="分辨率">{p.resolution ?? "—"}</Field>
        <Field label="帧率">{p.fps ?? "—"}</Field>
        <Field label="更新">{fmtTime(p.updated_at)}</Field>
      </div>

      <div data-testid="project-governance-issues">
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-faint">
          <span>治理检查明细</span>
          <span>{issues.length} 条</span>
        </div>
        {issues.length === 0 ? (
          <div className="rounded-md border border-success/30 bg-success/10 p-3 text-xs text-success">当前项目没有治理问题。</div>
        ) : (
          <div className="space-y-2">
            {issues.map((issue, index) => {
              const canLocate = Boolean(issue.asset_id || p.refs?.some((ref) => ref.reference_id === issue.reference_id));
              return (
                <div key={`${issue.code}-${issue.reference_id ?? issue.asset_id ?? index}`} data-issue-code={issue.code} className={`rounded-md border p-2.5 text-[11px] ${issue.level === "error" ? "border-danger/40 bg-danger/10" : issue.level === "warning" ? "border-warning/40 bg-warning/10" : "border-border-subtle bg-bg-raise2"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">{issue.level === "error" ? "错误" : issue.level === "warning" ? "警告" : "提示"} · {issue.code}</span>
                    {canLocate && <button onClick={() => locateIssue(issue)} className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover">定位资产</button>}
                  </div>
                  <div className="mt-1 leading-5 text-text-secondary">{issue.message}</div>
                  {(issue.reference_id || issue.asset_id) && <div className="mt-1 break-all font-mono text-[10px] text-text-faint">{issue.reference_id ?? issue.asset_id}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {p.refs && p.refs.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-text-faint">引用资产（{p.refs.length}）</div>
          <div className="space-y-1.5">
            {p.refs.slice(0, 10).map((r) => (
              <div key={r.reference_id} className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-text-primary">{r.role || r.asset?.title || r.asset_id}</span>
                  <span className="shrink-0 text-text-faint">{r.pin_mode ?? "—"}</span>
                </div>
                <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{r.asset_id}</div>
              </div>
            ))}
            {p.refs.length > 10 && <div className="text-[10px] text-text-faint">… 其余 {p.refs.length - 10} 条</div>}
          </div>
        </div>
      )}
    </div>
  );
}
