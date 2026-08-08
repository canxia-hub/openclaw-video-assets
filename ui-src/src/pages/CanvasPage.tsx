import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { rpc, type CanvasDocument, type CanvasShape } from "../lib/rpc";
import { useInspector } from "../lib/inspector";
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
  generation_slot: "text-danger border-danger/40 bg-danger/10",
};

/** 画布卡片节点：标题 + 类型徽标 + 主体摘要。 */
function ShapeNode({ data, selected }: NodeProps) {
  const shape = (data as { shape: CanvasShape }).shape;
  const isSection = shape.shape_type === "section";
  return (
    <div
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
        <Badge label={shape.shape_type} cls={TYPE_BADGE[shape.shape_type] ?? TYPE_BADGE.note} />
        {shape.subject_type && shape.subject_type !== shape.shape_type && (
          <span className="text-[9px] text-text-faint">{shape.subject_type}</span>
        )}
      </div>
      {shape.subject_id && !isSection && (
        <div className="mt-1 truncate font-mono text-[9px] text-text-faint">{shape.subject_id}</div>
      )}
    </div>
  );
}

const nodeTypes = { shapeCard: ShapeNode };

export default function CanvasPage() {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);

  const listQ = useQuery({
    queryKey: ["canvas.search"],
    queryFn: () => rpc<CanvasListItem[]>("canvas.search", { limit: 50 }),
  });

  const canvases = Array.isArray(listQ.data) ? listQ.data : [];
  const activeId = canvasId ?? canvases[0]?.canvas_id ?? null;

  const docQ = useQuery({
    queryKey: ["canvas.get", activeId],
    queryFn: () => rpc<CanvasDocument>("canvas.get", { canvas_id: activeId! }),
    enabled: !!activeId,
  });

  const { nodes, edges } = useMemo(() => {
    const doc = docQ.data;
    if (!doc) return { nodes: [] as Node[], edges: [] as Edge[] };
    const sorted = [...(doc.shapes ?? [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    const nodes: Node[] = sorted.map((s) => ({
      id: s.shape_id,
      type: "shapeCard",
      position: { x: s.x ?? 0, y: s.y ?? 0 },
      data: { shape: s },
      width: s.width ?? 220,
      height: s.height ?? 90,
      style: { width: s.width ?? 220, height: s.height ?? 90, zIndex: s.shape_type === "section" ? -1 : (s.z_index ?? 0) },
    }));
    const edges: Edge[] = (doc.edges ?? []).map((e) => ({
      id: e.edge_id,
      source: e.source_shape_id,
      target: e.target_shape_id,
      label: e.label ?? e.relation_type,
      type: "smoothstep",
      style: { stroke: "#7a7f99", strokeWidth: 1.5 },
      labelStyle: { fill: "#b8bdd4", fontSize: 11 },
      labelBgStyle: { fill: "#1a1c26", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    }));
    return { nodes, edges };
  }, [docQ.data]);

  return (
    <div className="relative flex h-full flex-col">
      {/* 画布选择条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-2.5">
        <span className="text-sm font-medium text-text-primary">画布</span>
        <select
          value={activeId ?? ""}
          onChange={(e) => setCanvasId(e.target.value)}
          className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          {canvases.map((c) => (
            <option key={c.canvas_id} value={c.canvas_id}>
              {c.title || c.canvas_id}（{c.shape_count ?? 0} 卡片）
            </option>
          ))}
        </select>
        {docQ.data && (
          <span className="text-xs text-text-faint">
            {docQ.data.shape_count ?? nodes.length} 卡片 · {docQ.data.edge_count ?? edges.length} 连线
          </span>
        )}
        {docQ.isLoading && <span className="text-xs text-text-faint">加载中…</span>}
        {docQ.isError && (
          <span className="text-xs text-danger">
            {docQ.error instanceof Error ? docQ.error.message : "加载失败"}
          </span>
        )}
      </div>

      {/* React Flow 画布 */}
      <div className="min-h-0 flex-1">
        {canvases.length === 0 && !listQ.isLoading ? (
          <EmptyState icon="✦" title="暂无画布" hint="通过 video_canvas_create 创建画布后，可在这里可视化节点与连线。" />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            minZoom={0.1}
            maxZoom={2.5}
            onNodeClick={(_, node) => {
              const shape = (node.data as { shape: CanvasShape }).shape;
              select({ kind: "shape", id: shape.shape_id, shape });
            }}
            onPaneClick={() => useInspector.getState().clear()}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            deleteKeyCode={null}
          >
            <Background gap={20} size={2} color="#4d5266" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-bg-raise1" nodeColor="#3a3e52" maskColor="rgba(10,11,16,0.7)" />
          </ReactFlow>
        )}
      </div>

      {selection?.kind === "shape" && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border-subtle bg-bg-raise1/90 px-2.5 py-1 text-[10px] text-text-faint">
          已选中：{(selection.shape.title ?? selection.id).slice(0, 30)}
        </div>
      )}
    </div>
  );
}
