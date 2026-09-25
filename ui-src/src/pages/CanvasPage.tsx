import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
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
import { mediaUrl } from "../lib/rpc";
import {
  CanvasEditingSession,
  copyCommandFromShapes,
  moveCommandFromNodes,
  type EditingSnapshot,
} from "../lib/canvas-editing";
import { initialViewportFor } from "../lib/canvas-viewport";

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

/**
 * 视口裁剪的边距（画布坐标）。
 *
 * 为什么留边距而不是严格按可见区裁剪：严格裁剪会在卡片刚滑入时才有 DOM，拖动视口时会看到卡片“跳”出来。
 * 留约 120 CSS px（在性能夹具的 0.5 zoom 下）让滑入连续；不预挂载整屏之外的数百张卡。
 * 旧值 600 个画布单位会在一次平移后把 300 卡夹具从 143 个节点扩到 268 个，实测平移仅 44.4fps。
 * 240 个画布单位仍给节点进入视口留出缓冲，同时把 DOM 工作量绑定在实际可见区附近。
 */
const CULL_MARGIN = 240;

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

/** 画布卡片节点：生产角色优先，技术类型作为次级字段；可见时懒加载缩略图。 */
function ShapeNode({ data, selected }: NodeProps) {
  const { shape, layoutAdjusted, readOnly, thumbnailVersionId } = data as {
    shape: CanvasShape;
    layoutAdjusted?: boolean;
    readOnly?: boolean;
    /** 只有这张卡在当前视口内、且已解析出版本号时才有值；否则不渲染 <img>。 */
    thumbnailVersionId?: string | null;
  };
  const isSection = shape.shape_type === "section";
  const productionRole = roleLabel(shape);
  const isAssetCard = shape.subject_type === "asset" && Boolean(shape.subject_id);
  return (
    <div
      data-shape-id={shape.shape_id}
      data-production-role={String(propsForShape(shape).role ?? "")}
      data-layout-adjusted={layoutAdjusted ? "true" : "false"}
      data-thumbnail={thumbnailVersionId ? "loaded" : isAssetCard ? "pending" : "n/a"}
      className={`h-full w-full overflow-hidden rounded-md border px-3 py-2 ${
        isSection
          ? "border-dashed border-border-subtle bg-bg-raise1/60"
          : `border-border-subtle bg-bg-raise1 ${selected ? "ring-2 ring-accent" : ""}`
      }`}
    >
      {!isSection && (
        <>
          {/**
           * 连接点的尺寸是功能性的，不是装饰：它是拖动连线的**唯一**落点。原来 8px 的圆点在 0.5 缩放下
           * 实际只有 4px，人手基本点不中——而 React Flow 默认的 strict 连接模式要求必须落在目标连接点上。
           * 14px + 可见描边把“能连线”从源码里的一句话变成手能做到的事。
           */}
          <Handle
            type="target"
            position={Position.Left}
            data-testid="canvas-handle-target"
            className="!h-3.5 !w-3.5 !border !border-bg-raise1 !bg-text-secondary hover:!bg-accent"
          />
          <Handle
            type="source"
            position={Position.Right}
            data-testid="canvas-handle-source"
            className="!h-3.5 !w-3.5 !border !border-bg-raise1 !bg-text-secondary hover:!bg-accent"
          />
        </>
      )}
      {isSection && (
        <>
          <Handle type="target" position={Position.Left} className="!h-3.5 !w-3.5 !border-0 !bg-transparent !opacity-0" />
          <Handle type="source" position={Position.Right} className="!h-3.5 !w-3.5 !border-0 !bg-transparent !opacity-0" />
        </>
      )}
      {isAssetCard && thumbnailVersionId ? (
        // 懒加载：只有卡片进入可见集、且版本号解析出来之后才发起图片请求。1000 卡时不会产生 1000 个请求。
        <img
          src={mediaUrl.thumb(thumbnailVersionId)}
          alt=""
          loading="lazy"
          decoding="async"
          data-testid="canvas-thumb"
          className="mb-1 h-12 w-full rounded object-cover"
        />
      ) : null}
      <div className="truncate text-xs font-medium text-text-primary">{shape.title || shape.shape_id}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {productionRole && <Badge label={productionRole} cls={TYPE_BADGE[shape.shape_type] ?? TYPE_BADGE.note} />}
        {layoutAdjusted && <Badge label="自动避让" cls="text-warning border-warning/40 bg-warning/10" />}
        <span className="text-[9px] text-text-faint">{shape.shape_type}</span>
        {readOnly && <span className="text-[9px] text-text-faint">只读</span>}
      </div>
      {shape.subject_id && !isSection && (
        <div className="mt-1 truncate font-mono text-[9px] text-text-faint">{shape.subject_id}</div>
      )}
    </div>
  );
}

const nodeTypes = { shapeCard: ShapeNode };

/** 保存状态的界面文案。刻意区分「未发送」与「已保存」——这正是验收要看的那条。 */
function saveStateText(snapshot: EditingSnapshot | null): { label: string; cls: string } {
  if (!snapshot) return { label: "—", cls: "border-border-subtle text-text-faint" };
  switch (snapshot.state) {
    case "clean":
      return { label: `已保存 r${snapshot.savedRevision}`, cls: "border-success/40 bg-success/10 text-success" };
    case "saving":
      return { label: "保存中…", cls: "border-border-subtle text-text-secondary" };
    case "pending":
      return { label: "有未保存改动", cls: "border-warning/40 bg-warning/10 text-warning" };
    case "saved":
      return { label: `已保存 r${snapshot.savedRevision}`, cls: "border-success/40 bg-success/10 text-success" };
    case "failed":
      return { label: "保存失败", cls: "border-danger/40 bg-danger/10 text-danger" };
    case "conflict":
      return { label: "版本冲突", cls: "border-danger/40 bg-danger/10 text-danger" };
    case "offline":
      return { label: "离线：未保存", cls: "border-warning/40 bg-warning/10 text-warning" };
    default:
      return { label: snapshot.state, cls: "border-border-subtle text-text-faint" };
  }
}

export default function CanvasPage() {
  const { canvasId: routeCanvasId } = useParams<{ canvasId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);
  const clearSelection = useInspector((s) => s.clear);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const restoredSelectionKeyRef = useRef<string | null>(null);
  void restoredSelectionKeyRef;
  const [flowViewport, setFlowViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [showGovernance, setShowGovernance] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveSnapshot, setSaveSnapshot] = useState<EditingSnapshot | null>(null);
  const [localNodes, setLocalNodes] = useState<Node[]>([]);
  const [localEdges, setLocalEdges] = useState<Edge[]>([]);
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<string, string>>({});
  const [viewportDecision, setViewportDecision] = useState<{ reason: string; content_bbox: unknown; fit_zoom: number | null; cards: number } | null>(null);
  /**
   * 选择由**客户端**拥有，不在每次选择变化时从服务端回读。
   *
   * 为什么：服务端的选择是防抖后才写的，因此它在几百毫秒内必然是旧的。如果重建节点时用服务端的值
   * 填 `selected`，那么**任何**选择变化（包括框选、Shift 多选）都会把刚做的选择抹回旧值——框选会画出
   * 选择框然后什么都不选中。服务端的值只在打开画布时用来做一次初始恢复。
   */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const seededSelectionRef = useRef<string | null>(null);
  const sessionRef = useRef<CanvasEditingSession | null>(null);
  const clipboardRef = useRef<CanvasShape[]>([]);
  const draggingRef = useRef(false);
  const lastWrittenViewportRef = useRef<string>("");
  const viewportTimerRef = useRef<number | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  /** 已为哪个 canvas 做过初始视图决策；以及视口是否已经稳定（稳定之前不落库）。 */
  const initialisedViewRef = useRef<string | null>(null);
  const viewportReadyRef = useRef(false);

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

  /**
   * 只读开关来自服务端（canvas.editing）。
   *
   * 界面据此收起手势，但**授权判定在服务端**：即使有人手工移除这里的禁用，applyCommand 仍会拒绝。
   * 界面这一侧只是不给出做不到的操作。
   */
  const readOnly = docQ.data?.editing?.editing === false;
  const readOnlyReason = docQ.data?.editing?.readOnlyReason ?? null;
  const viewportDebounceMs = docQ.data?.editing?.viewportDebounceMs ?? 400;

  /**
   * 编辑会话：**每个画布只建一次**。
   *
   * 曾经这里在 `docQ.data` 变化时就重建会话，而界面对文档的每一次后台刷新（包括一次拖拽带来的焦点刷新）都会
   * 让它变化。后果是一次被服务端拒绝的写入会被紧随其后的重建静默抹掉：冲突横幅一闪而过，用户看到的是“已保存”。
   * 现在只在首次加载时建，之后只把观察到的新版本号告诉它会话（`observeServerRevision`），而它拒绝在冲突未解决时
   * 采纳。
   */
  useEffect(() => {
    if (!activeId || !docQ.data) return;
    const revision = docQ.data.revision ?? 0;
    const existing = sessionRef.current;
    if (existing && existing.canvasId === activeId) {
      existing.observeServerRevision(revision);
      setSaveSnapshot(existing.snapshot());
      return;
    }
    const session = new CanvasEditingSession({
      canvasId: activeId,
      initialRevision: revision,
      onApplied: () => {
        setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
        void queryClient.invalidateQueries({ queryKey: ["canvas.get", activeId] });
        void queryClient.invalidateQueries({ queryKey: ["canvas.lint", activeId] });
      },
      onConflict: () => {
        setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
      },
    });
    session.setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    sessionRef.current = session;
    setSaveSnapshot(session.snapshot());
  }, [activeId, docQ.data, queryClient]);

  useEffect(() => {
    const restored = viewQ.data?.view_state?.viewport ?? viewQ.data?.fallback_viewport ?? docQ.data?.viewport;
    if (restored && restored.zoom) {
      setFlowViewport({ x: restored.x, y: restored.y, zoom: restored.zoom });
      viewportReadyRef.current = true;
    }
  }, [activeId, docQ.data?.viewport, viewQ.data]);

  /**
   * 初始视图：只在“这个画布没有存过视图状态”时做一次，而且**必须**做。
   *
   * 卡片现在只在视口内才挂载，所以视图落在空白处时用户看到的是空画布。存过视图状态就尊重它——
   * 用户上次看到的位置就是他想看到的位置。
   */
  useEffect(() => {
    if (!activeId || !docQ.data || viewQ.isLoading) return;
    if (initialisedViewRef.current === activeId) return;
    if (viewQ.data?.view_state?.viewport) {
      // The user's stored view wins; nothing to decide.
      initialisedViewRef.current = activeId;
      viewportReadyRef.current = true;
      return;
    }
    const shapes = docQ.data.shapes ?? [];
    if (shapes.length === 0) {
      initialisedViewRef.current = activeId;
      viewportReadyRef.current = true;
      return;
    }
    const decision = initialViewportFor(shapes, { width: window.innerWidth, height: window.innerHeight });
    initialisedViewRef.current = activeId;
    setFlowViewport({ x: decision.x, y: decision.y, zoom: decision.zoom });
    setViewportDecision({ reason: decision.reason, content_bbox: decision.content_bbox, fit_zoom: decision.fit_zoom, cards: shapes.length });
    viewportReadyRef.current = true;
  }, [activeId, docQ.data, viewQ.data, viewQ.isLoading]);

  /**
   * 打开画布时从服务端恢复一次选择；之后选择以本地为准。
   *
   * 旧实现每次 `selectionQ.data` 变化都写一次 store，而且重建节点时又用服务端值覆盖 `selected`，
   * 两者叠加的结果是选择永远以"几百毫秒前的那一次"为准。
   */
  useEffect(() => {
    const state = selectionQ.data;
    if (!activeId || !state) return;
    if (seededSelectionRef.current === activeId) return;
    seededSelectionRef.current = activeId;
    const ids = state.selected_shape_ids ?? [];
    setSelectedIds(ids);
    const primary = state.selected_shapes?.find((shape) => shape.shape_id === state.primary_shape_id) ?? state.selected_shapes?.[0];
    if (primary) select({ kind: "shape", id: primary.shape_id, shape: primary });
    else clearSelection();
  }, [activeId, clearSelection, select, selectionQ.data]);

  const displayPositions = useMemo(
    () => layoutCanvasShapes(docQ.data?.shapes ?? []),
    [docQ.data?.shapes],
  );

  /** 当前选中集合。只用于裁剪时保证选中的卡片不被卸载。 */
  const selectedShapeIds = useMemo(() => new Set(selectedIds), [selectedIds]);

  /**
   * 可见集：由当前视口和卡片几何算出的卡片 id 集合。
   *
   * 这是 300/1000 卡能用的关键：面板里挂载的节点数与**屏幕上看得见的卡片数**成正比，而不是与画布总量
   * 成正比。注意它只影响挂载，不影响文档内容——被裁掉的卡片仍然在本地数据里，撤销/重做/冲突检测
   * 照旧在完整集合上工作。
   */
  const visibleShapeIds = useMemo(() => {
    const shapes = docQ.data?.shapes ?? [];
    if (shapes.length === 0) return new Set<string>();
    const { x, y, zoom } = flowViewport;
    const width = (docQ.data?.viewport?.width ?? 1600) / (zoom || 1);
    const height = (docQ.data?.viewport?.height ?? 900) / (zoom || 1);
    const left = -x / (zoom || 1) - CULL_MARGIN;
    const top = -y / (zoom || 1) - CULL_MARGIN;
    const right = left + width + CULL_MARGIN * 2;
    const bottom = top + height + CULL_MARGIN * 2;
    const visible = new Set<string>();
    for (const shape of shapes) {
      const position = displayPositions.get(shape.shape_id) ?? { x: shape.x, y: shape.y };
      const shapeWidth = shape.width ?? 220;
      const shapeHeight = shape.height ?? 90;
      const intersects = position.x + shapeWidth >= left && position.x <= right && position.y + shapeHeight >= top && position.y <= bottom;
      if (intersects) visible.add(shape.shape_id);
    }
    // 选中的卡片永远挂载：否则框选后把视口挪开，选中的东西就“消失”了，而状态还认为它被选中。
    for (const id of selectedShapeIds) visible.add(id);
    return visible;
  }, [displayPositions, docQ.data?.shapes, docQ.data?.viewport?.height, docQ.data?.viewport?.width, flowViewport, selectedShapeIds]);

  /** 从文档构建节点。只挂载可见集；其余留在数据里但不进 DOM。 */
  const buildNodes = useCallback(
    (doc: CanvasDocument): Node[] => {
      const sorted = [...(doc.shapes ?? [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
      const nodes: Node[] = [];
      for (const shape of sorted) {
        if (!visibleShapeIds.has(shape.shape_id)) continue;
        const resolvedPosition = displayPositions.get(shape.shape_id);
        const position = resolvedPosition ?? { x: shape.x ?? 0, y: shape.y ?? 0 };
        nodes.push({
          id: shape.shape_id,
          type: "shapeCard",
          position: { x: position.x, y: position.y },
          data: {
            shape,
            layoutAdjusted: resolvedPosition?.adjusted ?? false,
            readOnly,
            thumbnailVersionId: shape.subject_type === "asset" && shape.subject_id ? (thumbnailVersions[shape.subject_id] ?? null) : null,
          },
          selected: selectedShapeIds.has(shape.shape_id),
          width: shape.width ?? 220,
          height: shape.height ?? 90,
          style: {
            width: shape.width ?? 220,
            height: shape.height ?? 90,
            zIndex: shape.shape_type === "section" ? -1 : (shape.z_index ?? 0),
          },
        });
      }
      return nodes;
    },
    [displayPositions, readOnly, selectedShapeIds, thumbnailVersions, visibleShapeIds],
  );

  const buildEdges = useCallback(
    (doc: CanvasDocument): Edge[] =>
      (doc.edges ?? [])
        // 两端都挂载时才画线：React Flow 对缺失端点的边会告警并丢弃，与其让它丢弃，不如这里就不生成。
        .filter((edge) => visibleShapeIds.has(edge.source_shape_id) && visibleShapeIds.has(edge.target_shape_id))
        .map((edge) => ({
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
        })),
    [selection, visibleShapeIds],
  );

  // 文档或可见集变化时重建本地节点；拖拽进行中不重建，避免把手指下的卡片拽回去。
  useEffect(() => {
    if (!docQ.data || draggingRef.current) return;
    setLocalNodes(buildNodes(docQ.data));
    setLocalEdges(buildEdges(docQ.data));
  }, [buildEdges, buildNodes, docQ.data]);

  /* ---------------- 视口：防抖写入，且只在值真的变化时写 ---------------- */

  const persistViewport = useCallback(
    async (next: Viewport) => {
      if (!activeId) return;
      const fingerprint = `${Math.round(next.x)}:${Math.round(next.y)}:${Number(next.zoom).toFixed(3)}`;
      if (fingerprint === lastWrittenViewportRef.current) return;
      lastWrittenViewportRef.current = fingerprint;
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
    },
    [activeId, docQ.data?.viewport?.height, docQ.data?.viewport?.width, queryClient],
  );

  /**
   * 视口变化：先更新本地视图（保证平移跟手），再防抖落库。
   *
   * 防抖是硬要求（2 秒内 20 次视口事件最多 2 次写入），但同样重要的是「只写变化过的值」：反复平移回
   * 同一个位置不应该产生任何写入。两者都在这里，所以“20 次事件”实际上会归并成 0–2 次。
   */
  const handleViewportChange = useCallback(
    (next: Viewport) => {
      setFlowViewport(next);
      // 初始视图还没定下来之前不落库：否则会把默认视口当成"用户的选择"存起来，下次打开就再也不会做
      // 初始视图决策了（而裁剪会让那块空白变成"空画布"）。
      if (!viewportReadyRef.current) return;
      if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        viewportTimerRef.current = null;
        void persistViewport(next);
      }, viewportDebounceMs);
    },
    [persistViewport, viewportDebounceMs],
  );

  /* ---------------- 缩略图：只有进入可见集才解析版本号 ---------------- */

  const pendingThumbnailAssets = useMemo(() => {
    const shapes = docQ.data?.shapes ?? [];
    const needed = new Set<string>();
    for (const shape of shapes) {
      if (shape.subject_type !== "asset" || !shape.subject_id) continue;
      if (!visibleShapeIds.has(shape.shape_id)) continue;
      if (thumbnailVersions[shape.subject_id]) continue;
      needed.add(shape.subject_id);
    }
    return needed;
  }, [docQ.data?.shapes, thumbnailVersions, visibleShapeIds]);

  useEffect(() => {
    if (!activeId || pendingThumbnailAssets.size === 0) return;
    let cancelled = false;
    // 视口停下之后再解析，避免平移过程中反复请求。
    const timer = window.setTimeout(async () => {
      try {
        const context = await rpc<{ visible_shapes?: (CanvasShape & { subject_context?: { default_version_id?: string } })[] }>(
          "canvas.agentContext",
          {
            canvas_id: activeId,
            viewport: {
              ...flowViewport,
              width: docQ.data?.viewport?.width ?? window.innerWidth,
              height: docQ.data?.viewport?.height ?? window.innerHeight,
            },
          },
        );
        if (cancelled) return;
        const resolved: Record<string, string> = {};
        for (const shape of context.visible_shapes ?? []) {
          const versionId = shape.subject_context?.default_version_id;
          if (shape.subject_type === "asset" && shape.subject_id && versionId) resolved[shape.subject_id] = versionId;
        }
        if (Object.keys(resolved).length > 0) {
          setThumbnailVersions((current) => ({ ...current, ...resolved }));
        }
      } catch {
        // 缩略图解析失败不影响编辑：没有图就是没有图，不阻塞任何写入路径。
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeId, docQ.data?.viewport?.height, docQ.data?.viewport?.width, flowViewport, pendingThumbnailAssets]);

  /* ---------------- 在线/离线 ---------------- */

  useEffect(() => {
    const goOnline = () => {
      sessionRef.current?.setOnline(true);
      setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
      void sessionRef.current?.flushQueue().then(() => {
        setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
        if (activeId) void queryClient.invalidateQueries({ queryKey: ["canvas.get", activeId] });
      });
    };
    const goOffline = () => {
      sessionRef.current?.setOnline(false);
      setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [activeId, queryClient]);

  /* ---------------- 手势 → 命令 ---------------- */

  const refreshAfterCommand = useCallback(() => {
    setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
    if (activeId) void queryClient.invalidateQueries({ queryKey: ["canvas.get", activeId] });
  }, [activeId, queryClient]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setLocalNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setLocalEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  /**
   * 拖拽结束：把**这一次拖拽涉及的所有卡片**合并成一条 move_shapes 命令。
   *
   * 为什么在这里写而不是 onNodesChange：逐帧写会在一次拖拽里产生几十次写入，把版本号推高几十次，也把
   * 命令日志淹掉。React Flow 在拖拽结束时给出的节点集合正是“这次拖拽的最终坐标”，合并成一条命令后，
   * 一次拖拽 = 一次写入 = 一个版本号 = 一条可撤销的记录。
   */
  const onNodeDragStop = useCallback(
    async (_event: unknown, _node: Node, draggedNodes: Node[]) => {
      draggingRef.current = false;
      const session = sessionRef.current;
      if (!session || readOnly) return;
      const command = moveCommandFromNodes(draggedNodes.map((item) => ({ id: item.id, position: item.position })));
      if (!command) return;
      const ok = await session.apply(command, `移动 ${draggedNodes.length} 张卡片`);
      if (!ok) {
        // 失败就不能显示成已保存：把本地节点退回服务端文档的状态。
        setActionError(session.lastError);
      }
      refreshAfterCommand();
      if (activeId) void queryClient.invalidateQueries({ queryKey: ["canvas.lint", activeId] });
    },
    [activeId, queryClient, readOnly, refreshAfterCommand],
  );

  const onConnect = useCallback(
    async (connection: { source?: string | null; target?: string | null }) => {
      const session = sessionRef.current;
      if (!session || readOnly) return;
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      // id 由客户端生成并写进负载：撤销后重做必须把同一条连线用同一个 id 建回来。
      const edgeId = `edge_ui_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const ok = await session.apply(
        {
          type: "create_edges",
          edges: [
            {
              edge_id: edgeId,
              source_shape_id: connection.source,
              target_shape_id: connection.target,
              relation_type: "related_to",
              label: RELATION_LABELS.related_to,
            },
          ],
        },
        "连接两张卡片",
      );
      if (!ok) setActionError(session.lastError);
      // 乐观地把这条线画上去：命令已成功才会走到这里，失败时上面已经报了错，不会假装成功。
      if (ok) {
        setLocalEdges((current) => [
          ...current,
          {
            id: edgeId,
            source: connection.source!,
            target: connection.target!,
            label: RELATION_LABELS.related_to,
            type: "smoothstep",
            style: { stroke: "#7a7f99", strokeWidth: 1.5 },
          },
        ]);
      }
      refreshAfterCommand();
    },
    [readOnly, refreshAfterCommand],
  );

  const deleteShapes = useCallback(
    async (shapeIds: string[]) => {
      const session = sessionRef.current;
      if (!session || readOnly || shapeIds.length === 0) return;
      // 删卡 = 从画布上移除卡片。这条命令的名字里没有资产概念，命令协议里也没有能碰到资产的字段，
      // 所以“删卡不删资产”是结构上的性质，不依赖调用方自觉。
      const ok = await session.apply({ type: "delete_shapes", shape_ids: shapeIds }, `移除 ${shapeIds.length} 张卡片`);
      if (!ok) setActionError(session.lastError);
      refreshAfterCommand();
    },
    [readOnly, refreshAfterCommand],
  );

  const pasteClipboard = useCallback(async () => {
    const session = sessionRef.current;
    const shapes = clipboardRef.current;
    if (!session || readOnly || shapes.length === 0) return;
    const { command } = copyCommandFromShapes(
      shapes.map((shape) => ({
        shape_id: shape.shape_id,
        shape_type: shape.shape_type,
        subject_type: shape.subject_type,
        subject_id: shape.subject_id,
        title: shape.title,
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        rotation: shape.rotation,
        z_index: shape.z_index,
        props: propsForShape(shape),
      })),
    );
    const ok = await session.apply(command, `粘贴 ${shapes.length} 张卡片`);
    if (!ok) setActionError(session.lastError);
    refreshAfterCommand();
  }, [readOnly, refreshAfterCommand]);

  const undo = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || readOnly) return;
    const ok = await session.undo();
    if (!ok) setActionError(session.lastError);
    refreshAfterCommand();
  }, [readOnly, refreshAfterCommand]);

  const redo = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || readOnly) return;
    const ok = await session.redo();
    if (!ok) setActionError(session.lastError);
    refreshAfterCommand();
  }, [readOnly, refreshAfterCommand]);

  /** 冲突恢复：重新载入文档，把会话对齐到服务端版本。**不重试那条命令。** */
  const resolveConflictByReload = useCallback(async () => {
    if (!activeId) return;
    const doc = await rpc<CanvasDocument>("canvas.get", { canvas_id: activeId });
    queryClient.setQueryData(["canvas.get", activeId], doc);
    sessionRef.current?.resync(doc.revision ?? 0);
    setActionError(null);
    setSaveSnapshot(sessionRef.current?.snapshot() ?? null);
    setLocalNodes(buildNodes(doc));
    setLocalEdges(buildEdges(doc));
  }, [activeId, buildEdges, buildNodes, queryClient]);

  /* ---------------- 键盘：删除 / 复制粘贴 / 撤销重做 ---------------- */

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // 在输入框里按键是打字，不是画布手势。
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (selection?.kind === "edge" && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        const session = sessionRef.current;
        if (!session || readOnly) return;
        void session.apply({ type: "delete_edges", edge_ids: [selection.id] }, "断开一条连线").then((ok) => {
          if (!ok) setActionError(session.lastError);
          refreshAfterCommand();
        });
        return;
      }
      const selectedNodes = localNodes.filter((node) => node.selected);
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedNodes.length === 0) return;
        event.preventDefault();
        void deleteShapes(selectedNodes.map((node) => node.id));
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void redo();
      } else if (key === "c") {
        const shapes = (docQ.data?.shapes ?? []).filter((shape) => selectedNodes.some((node) => node.id === shape.shape_id));
        if (shapes.length === 0) return;
        event.preventDefault();
        clipboardRef.current = shapes;
      } else if (key === "v") {
        event.preventDefault();
        void pasteClipboard();
      } else if (key === "a") {
        event.preventDefault();
        setLocalNodes((current) => current.map((node) => ({ ...node, selected: true })));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteShapes, docQ.data?.shapes, localNodes, pasteClipboard, readOnly, redo, refreshAfterCommand, selection, undo]);

  /* ---------------- 选择：写视图状态，不占版本号 ---------------- */

  /** 选择写入服务端：防抖，且属于**视图状态**，不占文档版本号。 */
  const persistSelection = useCallback(
    (ids: string[], primary: string | null) => {
      if (!activeId) return;
      if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = window.setTimeout(() => {
        selectionTimerRef.current = null;
        void rpc<CanvasSelectionState>("canvas.saveSelection", {
          canvas_id: activeId,
          selected_shape_ids: ids,
          primary_shape_id: primary,
          source: "workbench_canvas",
        })
          .then((state) => queryClient.setQueryData(["canvas.getSelection", activeId], state))
          .catch(() => {
            // 选择是视图状态，写不进去不影响文档；不弹错，避免噪音盖住真正的失败。
          });
      }, 300);
    },
    [activeId, queryClient],
  );

  const onSelectionChange = useCallback(
    (params: { nodes: Node[] }) => {
      const ids = params.nodes.map((node) => node.id);
      setSelectedIds(ids);
      const primary = params.nodes[0]?.data as { shape?: CanvasShape } | undefined;
      if (primary?.shape) select({ kind: "shape", id: primary.shape.shape_id ?? ids[0], shape: primary.shape });
      else clearSelection();
      persistSelection(ids, ids[0] ?? null);
    },
    [clearSelection, persistSelection, select],
  );

  /* ---------------- 其余既有交互 ---------------- */

  /**
   * 点选一张卡片：本地立即生效，并写回服务端（防抖）。
   *
   * 不再在这里直接写服务端：一次点击没必要等一个往返才看到选中，而写回由 persistSelection 统一做。
   */
  const selectCanvasShape = (shape: CanvasShape) => {
    setLocalNodes((current) => current.map((node) => ({ ...node, selected: node.id === shape.shape_id })));
    setSelectedIds([shape.shape_id]);
    select({ kind: "shape", id: shape.shape_id, shape });
    persistSelection([shape.shape_id], shape.shape_id);
  };

  const clearCanvasSelection = () => {
    clearSelection();
    setLocalNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setSelectedIds([]);
    persistSelection([], null);
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

  const routeCanvasMissing = Boolean(routeCanvasId && listQ.data && !canvases.some((item) => item.canvas_id === routeCanvasId));
  const lint = lintQ.data;
  const saveState = saveStateText(saveSnapshot);
  const conflict = saveSnapshot?.conflict ?? null;

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
          <span className="text-xs text-text-faint" data-testid="canvas-counts">
            {docQ.data.shape_count ?? localNodes.length} 卡片 · {docQ.data.edge_count ?? localEdges.length} 连线 · 版本 r{docQ.data.revision ?? 0} · 挂载 {localNodes.length}
          </span>
        )}
        {viewportDecision && (
          <span className="text-[10px] text-text-faint" data-testid="canvas-initial-view" data-reason={viewportDecision.reason}>
            初始视图：{viewportDecision.reason}
          </span>
        )}
        <span className={`rounded-md border px-2 py-1 text-[11px] ${saveState.cls}`} data-testid="canvas-save-state" data-save-state={saveSnapshot?.state ?? "unknown"}>
          {saveState.label}
        </span>
        {!readOnly && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void undo()}
              disabled={!saveSnapshot?.undoDepth}
              data-testid="canvas-undo"
              className="rounded border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            >
              撤销
            </button>
            <button
              type="button"
              onClick={() => void redo()}
              disabled={!saveSnapshot?.redoDepth}
              data-testid="canvas-redo"
              className="rounded border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
            >
              重做
            </button>
          </span>
        )}
        {readOnly && (
          <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="canvas-readonly">
            只读：{readOnlyReason ?? "编辑已关闭"}
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

      {conflict && (
        // 冲突是给人看的结论，不是「重试一下」。这里不提供重试按钮——重试就是用过期文档覆盖别人的编辑。
        <div className="flex flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger" data-testid="canvas-conflict">
          <span>
            文档已被其他会话修改：本地版本 r{conflict.expected}，服务端版本 r{conflict.actual}。你的这次改动**没有**保存。
          </span>
          <button
            type="button"
            onClick={() => void resolveConflictByReload()}
            data-testid="canvas-conflict-reload"
            className="rounded border border-danger/60 px-2 py-0.5 text-[11px] hover:bg-danger/20"
          >
            重新载入最新版本
          </button>
        </div>
      )}

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
            nodes={localNodes}
            edges={localEdges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            viewport={flowViewport}
            onViewportChange={handleViewportChange}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={() => { draggingRef.current = true; }}
            onNodeDragStop={(event, node, nodes) => void onNodeDragStop(event, node, nodes)}
            onConnect={(connection) => void onConnect(connection)}
            onSelectionChange={onSelectionChange}
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
            // 编辑手势：只读时全部关掉。授权仍在服务端，这里只是不给出做不到的操作。
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            // 左键拖出框选，中键/右键平移：只读看板与编辑器共用同一块画布，框选是编辑器的首要手势。
            selectionOnDrag={!readOnly}
            panOnDrag={[1, 2]}
            selectionMode={SelectionMode.Partial}
            multiSelectionKeyCode="Shift"
            // 删除键自己处理（删除要变成一条 delete_shapes 命令），所以不让 React Flow 接管。
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
              <button type="button" aria-label="关闭治理问题面板" onClick={() => setShowGovernance(false)} className="text-xs text-text-faint">×</button>
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
        {!readOnly && (
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-border-subtle bg-bg-raise1/90 px-2.5 py-1 text-[10px] text-text-faint">
            拖动卡片移动 · 拖动端点连线 · 空白拖出框选 · Shift 多选 · Delete 移除卡片 · Ctrl+C/V 复制粘贴 · Ctrl+Z 撤销
          </div>
        )}
      </div>
    </div>
  );
}
