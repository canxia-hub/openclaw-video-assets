import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rpc } from "../lib/rpc";
import { Badge, licenseBadge, riskBadge } from "../components/ui";

interface CanvasListItem {
  canvas_id: string;
  title?: string;
  shape_count?: number;
}

interface SlotRef {
  slot?: string;
  shape_id?: string;
  title?: string;
  reference_id?: string;
  asset_id?: string;
  asset_version_id?: string;
  role?: string;
  pin_mode?: string;
  required?: boolean;
  media_type?: string;
  license_status?: string;
  risk_level?: string;
}

interface GenPackage {
  generation_type?: string;
  version?: string;
  canvas?: { canvas_id?: string; title?: string };
  project?: { project_id?: string; title?: string };
  target_spec?: { aspect_ratio?: string; resolution?: string; fps?: number; duration_seconds?: number };
  slots?: Record<string, SlotRef[]>;
  generation_slots?: unknown[];
  active_generation_slot?: unknown;
  gates?: { ok?: boolean; errors?: string[]; warnings?: string[] };
  production_stage_gaps?: unknown[];
  inputs?: unknown;
  [k: string]: unknown;
}

const GEN_TYPES: { value: string; label: string }[] = [
  { value: "image", label: "文生图 image" },
  { value: "image_to_video", label: "图生视频 image_to_video" },
  { value: "text_to_video", label: "文生视频 text_to_video" },
  { value: "multimodal_to_video", label: "多模态视频 multimodal_to_video" },
  { value: "edit", label: "编辑 edit" },
  { value: "voice", label: "配音 voice" },
  { value: "subtitle", label: "字幕 subtitle" },
  { value: "cover", label: "封面 cover" },
  { value: "export", label: "导出 export" },
];

export default function GenPrepPage() {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [genType, setGenType] = useState("image");
  const [jsonOpen, setJsonOpen] = useState(false);

  const listQ = useQuery({
    queryKey: ["canvas.search"],
    queryFn: () => rpc<CanvasListItem[]>("canvas.search", { limit: 50 }),
  });
  const canvases = Array.isArray(listQ.data) ? listQ.data : [];
  const activeId = canvasId ?? canvases[0]?.canvas_id ?? null;

  const pkgQ = useQuery({
    queryKey: ["canvas.generationPackage", activeId, genType],
    queryFn: () => rpc<GenPackage>("canvas.generationPackage", { canvas_id: activeId!, generation_type: genType }),
    enabled: !!activeId,
  });

  const pkg = pkgQ.data;
  const gates = pkg?.gates;
  const slots = pkg?.slots ?? {};
  const slotEntries = Object.entries(slots);

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">生成准备</h1>
      <p className="mb-4 text-sm text-text-secondary">选择画布与生成类型，查看参考槽位匹配、预检警告与结构化输入包。</p>

      {/* 选择条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={activeId ?? ""}
          onChange={(e) => setCanvasId(e.target.value)}
          className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {canvases.map((c) => (
            <option key={c.canvas_id} value={c.canvas_id}>
              {c.title || c.canvas_id}
            </option>
          ))}
        </select>
        <select
          value={genType}
          onChange={(e) => setGenType(e.target.value)}
          className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {GEN_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {pkgQ.isLoading && <span className="text-xs text-text-faint">生成包加载中…</span>}
        {pkgQ.isError && (
          <span className="text-xs text-danger">{pkgQ.error instanceof Error ? pkgQ.error.message : "加载失败"}</span>
        )}
      </div>

      {pkg && (
        <div className="max-w-4xl space-y-5">
          {/* 预检门 */}
          {gates && (
            <section
              className={`rounded-lg border p-4 ${
                gates.ok && !(gates.warnings?.length)
                  ? "border-success/40 bg-success/5"
                  : gates.errors?.length
                    ? "border-danger/40 bg-danger/5"
                    : "border-warn/40 bg-warn/5"
              }`}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">预检</span>
                {gates.ok ? (
                  <Badge label="通过" cls="text-success border-success/40 bg-success/10" />
                ) : (
                  <Badge label="未通过" cls="text-danger border-danger/40 bg-danger/10" />
                )}
                {!!gates.warnings?.length && (
                  <Badge label={`${gates.warnings.length} 警告`} cls="text-warn border-warn/40 bg-warn/10" />
                )}
              </div>
              {!!gates.errors?.length && (
                <ul className="mb-2 space-y-1">
                  {gates.errors.map((e, i) => (
                    <li key={i} className="text-xs text-danger">✕ {e}</li>
                  ))}
                </ul>
              )}
              {!!gates.warnings?.length && (
                <ul className="space-y-1">
                  {gates.warnings.map((w, i) => (
                    <li key={i} className="text-xs text-warn">⚠ {w}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* 目标规格 */}
          {pkg.target_spec && (
            <section className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
              <div className="mb-2 text-sm font-medium text-text-primary">目标规格</div>
              <div className="flex flex-wrap gap-1.5">
                {pkg.target_spec.aspect_ratio && <Badge label={`画幅 ${pkg.target_spec.aspect_ratio}`} cls="text-text-secondary border-border-subtle" />}
                {pkg.target_spec.resolution && <Badge label={pkg.target_spec.resolution} cls="text-text-secondary border-border-subtle" />}
                {pkg.target_spec.fps != null && <Badge label={`${pkg.target_spec.fps} fps`} cls="text-text-secondary border-border-subtle" />}
                {pkg.target_spec.duration_seconds != null && <Badge label={`${pkg.target_spec.duration_seconds}s`} cls="text-text-secondary border-border-subtle" />}
              </div>
            </section>
          )}

          {/* 槽位匹配 */}
          <section>
            <div className="mb-2 text-sm font-medium text-text-primary">
              参考槽位（{slotEntries.length} 组 · {slotEntries.reduce((n, [, arr]) => n + arr.length, 0)} 引用）
            </div>
            {slotEntries.length === 0 && (
              <div className="rounded-md border border-dashed border-border-subtle p-4 text-xs text-text-faint">
                该生成类型无匹配的参考槽位。
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {slotEntries.map(([slotName, refs]) => (
                <div key={slotName} className="rounded-lg border border-border-subtle bg-bg-raise1 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-accent">{slotName}</span>
                    <span className="text-[10px] text-text-faint">{refs.length} 引用</span>
                  </div>
                  <div className="space-y-1.5">
                    {refs.map((r, i) => {
                      const lic = licenseBadge(r.license_status);
                      const rk = riskBadge(r.risk_level);
                      return (
                        <div key={r.reference_id ?? i} className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-text-primary">{r.title || r.role || "—"}</span>
                            <span className="flex shrink-0 gap-1">
                              {r.required ? <Badge label="必需" cls="text-danger border-danger/40 bg-danger/10" /> : null}
                              <Badge label={lic.label} cls={lic.cls} />
                              <Badge label={rk.label} cls={rk.cls} />
                            </span>
                          </div>
                          <div className="mt-0.5 text-[10px] text-text-faint">
                            {r.media_type ?? "—"} · {r.pin_mode ?? "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 原始 JSON 折叠查看 */}
          <section className="rounded-lg border border-border-subtle bg-bg-raise1">
            <button
              onClick={() => setJsonOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs text-text-secondary hover:text-text-primary"
            >
              <span>结构化输入包 JSON</span>
              <span>{jsonOpen ? "▲ 收起" : "▼ 展开"}</span>
            </button>
            {jsonOpen && (
              <pre className="max-h-96 overflow-auto border-t border-border-subtle p-4 text-[10px] leading-4 text-text-secondary">
                {JSON.stringify(pkg, null, 2)}
              </pre>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
