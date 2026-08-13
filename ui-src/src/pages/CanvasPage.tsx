import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  rpc,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasIssue,
  type CanvasLint,
  type CanvasSelectionState,
  type CanvasShape,
  type CanvasViewState,
} from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { layoutCanvasShapes } from "../lib/canvas-layout";
import { Badge, EmptyState } from "../components/ui";

interface CanvasListItem {
  canvas_id: string;
  title?: string;
  project_id?: string;
  status?: string;
  shape_count?: number;
  edge_count?: number;
  updated_at?: string;
}

const TYPE_BADGE: Record<string, string> = {
  project_card: "text-accent border-accent/40 bg-accent-dim",
  asset_card: "text-success border-success/40 bg-success/10",
  entity_card: "text-warn border-warn/40 bg-warn/10",
  reference_card: "text-text-secondary border-border-subtle bg-bg-raise2",
  note: "text-text-faint border-border-subtle",
  section: "text-text-faint border-border-subtle",
};

const ROLE_LABELS: Record<string, string> = {
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

function propsForShape(shape: CanvasShape) {
  if (shape.props) return shape.props;
  if (shape.props_json) {
    try {
      return JSON.parse(shape.props_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function roleLabel(shape: CanvasShape) {
  const role = String(propsForShape(shape).role ?? "");
  return ROLE_LABELS[role] ?? role;
}

function edgeLabel(edge: CanvasEdge) {
  const stored = edge.label?.trim();
  const historical = Boolean(stored && /[A-Za-z]/.test(stored));
  if (historical) return `${RELATION_LABELS[edge.relation_type] ?? "关系"}（历史）`;
  return stored || RELATION_LABELS[edge.relation_type] || edge.relation_type;
}

/** 画布卡片节点：生产角色优先，技术类型作为次级字段。 */
function ShapeNode({ data, selected }: NodeProps) {
  const { shape, layoutAdjusted } = data as { shape: CanvasShape; layoutAdjusted?: boolean };
  const isSection = shape.shape_type === "section";
  const productionRole = roleLabel(shape);
  return (
    <div
      data-shape-id={shape.shape_id}
      data-production-role={String(propsForShape(shape).role ?? "")}
      data-layout-adjusted={layoutAdjusted ? "true" : "false"}
      className={`h-full w-full overflow-hidden rounded-md border px-3 py-2 ${
        isSection
          ? "border-dashed border-border-subtle bg-bg-raise1/60"
          : `border-border-subtle bg-bg-raise1 ${selected ? "ring-2 ring-accent" : ""}`
      }`}
    >
      {!isSection && (
        <>
          <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-text-faint" />
          <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-text-faint" />
        </>
      )}
      {isSection && (
        <>
          <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent !opacity-0" />
          <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent !opacity-0" />
        </>
      )}
      <div className="truncate text-xs font-medium text-text-primary">{shape.title || shape.shape_id}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {productionRole && <Badge label={productionRole} cls={TYPE_BADGE[shape.shape_type] ?? TYPE_BADGE.note} />}
        {layoutAdjusted && <Badge label="自动避让" cls="text-warning border-warning/40 bg-warning/10" />}
        <span className="text-[9px] text-text-faint">{shape.shape_type}</span>
      </div>
      {shape.subject_id && !isSection && (
        <div className="mt-1 truncate font-mono text-[9px] text-text-faint">{shape.subject_id}</div>
      )}
    </div>
  );
}

const nodeTypes = { shapeCard: ShapeNode };

export default function CanvasPage() {
  const { canvasId: routeCanvasId } = useParams<{ canvasId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);
  const clearSelection = useInspector((s) => s.clear);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const restoredSelectionKeyRef = useRef<string | null>(null);
  const [flowViewport, setFlowViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [showGovernance, setShowGovernance] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["canvas.search"],
    queryFn: () => rpc<CanvasListItem[]>("canvas.search", { limit: 50 }),
  });

  const canvases = Array.isArray(listQ.data) ? listQ.data : [];
  const activeId = routeCanvasId ?? canvases[0]?.canvas_id ?? null;

  useEffect(() => {
    if (!routeCanvasId && canvases[0]?.canvas_id) {
      navigate(`/canvas/${canvases[0].canvas_id}`, { replace: true });
    }
  }, [canvases, navigate, routeCanvasId]);

  const docQ = useQuery({
    queryKey: ["canvas.get", activeId],
    queryFn: () => rpc<CanvasDocument>("canvas.get", { canvas_id: activeId! }),
    enabled: !!activeId,
    retry: false,
  });

  const selectionQ = useQuery({
    queryKey: ["canvas.getSelection", activeId],
    queryFn: () => rpc<CanvasSelectionState>("canvas.getSelection", { canvas_id: activeId! }),
    enabled: !!activeId,
    retry: false,
  });

  const viewQ = useQuery({
    queryKey: ["canvas.getViewState", activeId],
    queryFn: () => rpc<CanvasViewState>("canvas.getViewState", { canvas_id: activeId! }),
    enabled: !!activeId,
    retry: false,
  });

  const lintQ = useQuery({
    queryKey: ["canvas.lint", activeId],
    queryFn: () => rpc<CanvasLint>("canvas.lint", { canvas_id: activeId! }),
    enabled: !!activeId,
    retry: false,
  });

  useEffect(() => {
    const restored = viewQ.data?.view_state?.viewport ?? viewQ.data?.fallback_viewport ?? docQ.data?.viewport;
    if (restored) setFlowViewport({ x: restored.x, y: restored.y, zoom: restored.zoom });
  }, [activeId, docQ.data?.viewport, viewQ.data]);

  useEffect(() => {
    const state = selectionQ.data;
    if (!activeId || !state) return;
    const restoreKey = `${activeId}:${state.updated_at ?? state.selected_shape_ids.join(",")}:${state.primary_shape_id ?? ""}`;
    if (restoredSelectionKeyRef.current === restoreKey) return;
    restoredSelectionKeyRef.current = restoreKey;
    const primary = state.selected_shapes?.find((shape) => shape.shape_id === state.primary_shape_id)
      ?? state.selected_shapes?.[0];
    if (primary) {
      select({ kind: "shape", id: primary.shape_id, shape: primary });
    } else {
      clearSelection();
    }
  }, [activeId, clearSelection, select, selectionQ.data]);

  const selectedShapeIds = useMemo(
    () => new Set(selectionQ.data?.selected_shape_ids ?? []),
    [selectionQ.data?.selected_shape_ids],
  );

  const displayPositions = useMemo(
    () => layoutCanvasShapes(docQ.data?.shapes ?? []),
    [docQ.data?.shapes],
  );

  const { nodes, edges } = useMemo(() => {
    const doc = docQ.data;
    if (!doc) return { nodes: [] as Node[], edges: [] as Edge[] };
    const sorted = [...(doc.shapes ?? [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    const nodes: Node[] = sorted.map((shape) => ({
      id: shape.shape_id,
      type: "shapeCard",
      position: {
        x: displayPositions.get(shape.shape_id)?.x ?? shape.x ?? 0,
        y: displayPositions.get(shape.shape_id)?.y ?? shape.y ?? 0,
      },
      data: { shape, layoutAdjusted: displayPositions.get(shape.shape_id)?.adjusted ?? false },
      selected: selectedShapeIds.has(shape.shape_id),
      width: shape.width ?? 220,
      height: shape.height ?? 90,
      style: {
        width: shape.width ?? 220,
        height: shape.height ?? 90,
        zIndex: shape.shape_type === "section" ? -1 : (shape.z_index ?? 0),
      },
    }));
    const edges: Edge[] = (doc.edges ?? []).map((edge) => ({
      id: edge.edge_id,
      source: edge.source_shape_id,
      target: edge.target_shape_id,
      label: edgeLabel(edge),
      selected: selection?.kind === "edge" && selection.id === edge.edge_id,
      type: "smoothstep",
      style: { stroke: "#7a7f99", strokeWidth: 1.5 },
      labelStyle: { fill: "#b8bdd4", fontSize: 11 },
      labelBgStyle: { fill: "#1a1c26", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    }));
    return { nodes, edges };
  }, [displayPositions, docQ.data, selectedShapeIds, selection]);

  const selectCanvasShape = async (shape: CanvasShape) => {
    if (!activeId) return;
    setActionError(null);
    try {
      const state = await rpc<CanvasSelectionState>("canvas.saveSelection", {
        canvas_id: activeId,
        selected_shape_ids: [shape.shape_id],
        primary_shape_id: shape.shape_id,
        source: "workbench_canvas",
      });
      queryClient.setQueryData(["canvas.getSelection", activeId], state);
      const enriched = state.selected_shapes?.find((item) => item.shape_id === shape.shape_id) ?? shape;
      select({ kind: "shape", id: enriched.shape_id, shape: enriched });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const clearCanvasSelection = async () => {
    clearSelection();
    if (!activeId) return;
    try {
      const state = await rpc<CanvasSelectionState>("canvas.saveSelection", {
        canvas_id: activeId,
        selected_shape_ids: [],
        source: "workbench_canvas",
      });
      queryClient.setQueryData(["canvas.getSelection", activeId], state);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const selectCanvasEdge = (edgeId: string) => {
    const edge = docQ.data?.edges.find((item) => item.edge_id === edgeId);
    if (!edge || !docQ.data) return;
    select({
      kind: "edge",
      id: edge.edge_id,
      edge,
      source: docQ.data.shapes.find((shape) => shape.shape_id === edge.source_shape_id),
      target: docQ.data.shapes.find((shape) => shape.shape_id === edge.target_shape_id),
    });
  };

  const focusIssue = async (issue: CanvasIssue) => {
    const shape = docQ.data?.shapes.find((item) => item.shape_id === issue.shape_id);
    if (!shape) return;
    const position = displayPositions.get(shape.shape_id) ?? { x: shape.x, y: shape.y };
    await selectCanvasShape(shape);
    await flowRef.current?.setCenter(
      position.x + (shape.width ?? 220) / 2,
      position.y + (shape.height ?? 90) / 2,
      { zoom: Math.max(flowViewport.zoom, 0.8), duration: 250 },
    );
  };

  const saveViewport = async (next: Viewport) => {
    if (!activeId) return;
    setFlowViewport(next);
    try {
      const state = await rpc<CanvasViewState>("canvas.saveViewState", {
        canvas_id: activeId,
        viewport: {
          ...next,
          width: docQ.data?.viewport?.width ?? window.innerWidth,
          height: docQ.data?.viewport?.height ?? window.innerHeight,
        },
        source: "workbench_canvas",
      });
      queryClient.setQueryData(["canvas.getViewState", activeId], state);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const routeCanvasMissing = Boolean(routeCanvasId && listQ.data && !canvases.some((item) => item.canvas_id === routeCanvasId));
  const lint = lintQ.data;

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5 sm:gap-3 sm:px-4">
        <span className="text-sm font-medium text-text-primary">画布</span>
        <select
          value={activeId ?? ""}
          onChange={(event) => navigate(`/canvas/${event.target.value}`)}
          className="min-w-0 max-w-full rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {routeCanvasMissing && activeId && <option value={activeId}>未找到：{activeId}</option>}
          {canvases.map((canvas) => (
            <option key={canvas.canvas_id} value={canvas.canvas_id}>
              {canvas.title || canvas.canvas_id}（{canvas.shape_count ?? 0} 卡片）
            </option>
          ))}
        </select>
        {docQ.data && (
          <span className="text-xs text-text-faint">
            {docQ.data.shape_count ?? nodes.length} 卡片 · {docQ.data.edge_count ?? edges.length} 连线 · 已恢复 {selectedShapeIds.size} 项选择
          </span>
        )}
        {lint && (
          <button
            type="button"
            onClick={() => setShowGovernance((value) => !value)}
            className={`rounded-md border px-2 py-1 text-[11px] ${lint.errors.length ? "border-danger/40 bg-danger/10 text-danger" : lint.warnings.length ? "border-warning/40 bg-warning/10 text-warning" : "border-success/40 bg-success/10 text-success"}`}
          >
            治理检查 {lint.errors.length} 错误 / {lint.warnings.length} 警告
          </button>
        )}
        {(docQ.isLoading || viewQ.isLoading || selectionQ.isLoading) && <span className="text-xs text-text-faint">加载状态中…</span>}
      </div>

      {(docQ.isError || listQ.isError || actionError) && (
        <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger" data-testid="canvas-route-error">
          {actionError ?? (docQ.error instanceof Error ? docQ.error.message : listQ.error instanceof Error ? listQ.error.message : "画布加载失败")}
        </div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 bg-bg-canvas">
        {!activeId && !listQ.isLoading ? (
          <EmptyState icon="✦" title="暂无画布" hint="通过 video_canvas_create 创建画布后，可在这里可视化节点与连线。" />
        ) : docQ.data ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            viewport={flowViewport}
            onViewportChange={setFlowViewport}
            onMoveEnd={(_, next) => void saveViewport(next)}
            onInit={(instance) => { flowRef.current = instance; }}
            minZoom={0.1}
            maxZoom={2.5}
            onNodeClick={(_, node) => {
              const shape = (node.data as { shape: CanvasShape }).shape;
              void selectCanvasShape(shape);
            }}
            onEdgeClick={(_, edge) => selectCanvasEdge(edge.id)}
            onPaneClick={() => void clearCanvasSelection()}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            nodesDraggable={false}
            deleteKeyCode={null}
          >
            <Background gap={20} size={2} color="#4d5266" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-bg-raise1" nodeColor="#3a3e52" maskColor="rgba(10,11,16,0.7)" />
          </ReactFlow>
        ) : null}

        {showGovernance && lint && lint.issues.length > 0 && (
          <div className="absolute right-3 top-3 z-20 max-h-[46%] w-[min(380px,calc(100%-24px))] overflow-y-auto rounded-lg border border-border-strong bg-bg-raise1/95 p-3" data-testid="canvas-governance-panel">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-text-primary">画布治理问题</div>
              <button type="button" onClick={() => setShowGovernance(false)} className="text-xs text-text-faint">×</button>
            </div>
            <div className="space-y-2">
              {lint.issues.map((issue, index) => (
                <div key={`${issue.code}-${issue.shape_id ?? issue.edge_id ?? index}`} data-issue-code={issue.code} className={`rounded-md border p-2 text-[11px] ${issue.level === "error" ? "border-danger/40 bg-danger/10" : issue.level === "warning" ? "border-warning/40 bg-warning/10" : "border-border-subtle bg-bg-raise2"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text-primary">{issue.level === "error" ? "错误" : issue.level === "warning" ? "警告" : "提示"} · {issue.code}</span>
                    {issue.shape_id && <button type="button" onClick={() => void focusIssue(issue)} className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-bg-hover">定位卡片</button>}
                  </div>
                  <div className="mt-1 leading-5 text-text-secondary">{issue.message}</div>
                  {(issue.shape_id || issue.asset_id || issue.edge_id) && <div className="mt-1 break-all font-mono text-[10px] text-text-faint">{issue.shape_id ?? issue.asset_id ?? issue.edge_id}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {selection?.kind === "shape" && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border-subtle bg-bg-raise1/90 px-2.5 py-1 text-[10px] text-text-faint">
            已选中：{(selection.shape.title ?? selection.id).slice(0, 30)}
          </div>
        )}
        {selection?.kind === "edge" && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border-subtle bg-bg-raise1/90 px-2.5 py-1 text-[10px] text-text-faint">
            已选关系：{edgeLabel(selection.edge)}
          </div>
        )}
      </div>
    </div>
  );
}
