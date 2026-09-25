/**
 * REN-08：画布编辑会话（客户端命令引擎）。
 *
 * 职责边界：本模块只管**命令与版本**，不碰渲染。页面负责把鼠标手势翻译成命令，本模块负责
 * “引用哪个 revision 写、写失败了算什么状态、撤销重做往哪走”。
 *
 * 三条设计底线（都来自验收条款，不是风格偏好）：
 *
 * 1. **ID 由客户端生成**。撤销要重放命令负载，redo 必须能把同一行用同一个 id 建回来。若 id 由服务端
 *    临时生成，重放时必然变成新 id，交付物里的“所有引用ID不变”就不成立。因此 create_shapes /
 *    create_edges 的 id 全部在这里生成并写进负载。
 *
 * 2. **只有真正写成功才叫已保存**。`savedRevision` 只在服务端返回新 revision 后推进；任何失败都让
 *    `dirty` 保持为真，并把原因留在 `lastError`。离线时连发都不发，直接标记未保存——「排队等着发」
 *    与「已保存」是两件事，界面不能混。
 *
 * 3. **冲突不是错误，是一个要给人看的结论**。409 意味着别人的编辑已经落地，此时**不能**重试，
 *    必须暴露当前 revision 与自己的 revision，让人选择重新载入还是另存。重试会静默覆盖别人。
 */
import { RpcError, rpc, type CanvasCommand, type CanvasCommandResult } from "./rpc";

/** 编辑器一次会话的客户端身份，用于在命令日志里区分“谁改的”。 */
export function createClientId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `web-${Date.now().toString(36)}-${random}`;
}

/**
 * 生成一个带前缀的客户端 id。
 *
 * 前缀刻意沿用服务端的命名习惯（shape_/edge_），因为这些 id 会长期留在库里，也会出现在命令日志、
 * 画布卡片 DOM 与断言里；用一个“一看就知道是画布对象”的前缀，比一串无前缀随机串更容易排查。
 */
export function clientObjectId(prefix: "shape" | "edge"): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `${prefix}_ui_${stamp}${random}`;
}

export type SaveState = "clean" | "pending" | "saving" | "saved" | "failed" | "conflict" | "offline";

export interface EditingSnapshot {
  revision: number;
  savedRevision: number;
  dirty: boolean;
  state: SaveState;
  undoDepth: number;
  redoDepth: number;
  lastError: string | null;
  conflict: { expected: number; actual: number; message: string } | null;
  inFlight: number;
  pendingCommands: number;
}

interface HistoryEntry {
  /** 前向命令（重做时重放它）。 */
  command: CanvasCommand;
  /** 服务端记录的逆命令（撤销时把它们当新命令应用）。 */
  inverse: CanvasCommand[];
  /** 人话描述，用于界面上的操作提示。 */
  label: string;
}

export interface EditingSessionOptions {
  canvasId: string;
  clientId?: string;
  initialRevision: number;
  /** 命令成功落地后的回调：页面据此刷新文档缓存。 */
  onApplied?: (result: CanvasCommandResult, command: CanvasCommand) => void;
  /** 发生冲突时的回调：页面据此提示“重新载入”。 */
  onConflict?: (info: { expected: number; actual: number; message: string }) => void;
}

/**
 * 编辑会话。
 *
 * 这里**不做乐观 UI**：命令的最终形态由服务端回执与随后的文档刷新决定。原因很直接——验收要求
 * “失败写入不显示为保存成功”。如果界面先按本地推断把卡片画到新位置，再把失败默默吞掉，那条要求
 * 就没有意义了。拖拽期间的跟手效果由 React Flow 自己的本地渲染提供，不需要复制一份状态到命令引擎。
 */
export class CanvasEditingSession {
  readonly canvasId: string;
  readonly clientId: string;
  /** 客户端认为文档当前处于哪个 revision。写命令时作为 expected_revision。 */
  revision: number;
  /** 服务端已确认落地的 revision。只有它推进，才算“已保存”。 */
  savedRevision: number;
  state: SaveState = "clean";
  lastError: string | null = null;
  conflict: EditingSnapshot["conflict"] = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private inFlight = 0;
  private queue: { command: CanvasCommand; label: string }[] = [];
  private online = true;
  private readonly options: EditingSessionOptions;

  constructor(options: EditingSessionOptions) {
    this.options = options;
    this.canvasId = options.canvasId;
    this.clientId = options.clientId ?? createClientId();
    this.revision = options.initialRevision;
    this.savedRevision = options.initialRevision;
  }

  snapshot(): EditingSnapshot {
    return {
      revision: this.revision,
      savedRevision: this.savedRevision,
      dirty: this.revision !== this.savedRevision,
      state: this.state,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      lastError: this.lastError,
      conflict: this.conflict,
      inFlight: this.inFlight,
      pendingCommands: this.queue.length,
    };
  }

  /** 服务端文档被重新载入后调用：把版本对齐，清掉历史（旧历史已无法安全重放）。 */
  resync(revision: number): void {
    this.revision = revision;
    this.savedRevision = revision;
    this.undoStack = [];
    this.redoStack = [];
    this.conflict = null;
    this.lastError = null;
    this.state = this.online ? "clean" : "offline";
  }

  /**
   * 接受后台刷新观察到的新版本号——**但不允许它覆掉未解决的冲突**。
   *
   * 为什么需要这个方法：界面会在窗口获得焦点时重新拉取文档（React Query 默认行为），而一次拖拽就会让窗口获得
   * 焦点。若把“文档刷新”当成“重建会话”，那么一次被服务端拒绝的写入会被紧随其后 的重建**静默抹掉**——冲突横幅
   * 一闪而过，用户看到的是“已保存”。这正是“失败写入不显示为保存成功”的反面：**冲突不得被悄悄丢掉**。
   *
   * 三种情况下不采纳：
   *   * 有未解决的冲突 —— 让人先看到它并做选择；
   *   * 有写入在途 —— 它的 expected_revision 不能被改掉；
   *   * 有离线队列 —— 队列里的命令还没落地。
   *
   * @returns 是否采纳了新版本号
   */
  observeServerRevision(revision: number): boolean {
    if (this.conflict) return false;
    if (this.inFlight > 0) return false;
    if (this.queue.length > 0) return false;
    if (revision === this.revision) {
      this.savedRevision = revision;
      if (this.state === "saved") this.state = "clean";
      return false;
    }
    this.revision = revision;
    this.savedRevision = revision;
    this.state = this.online ? "clean" : "offline";
    // The undo/redo stacks are deliberately KEPT. They name explicit ids, so applying one against a newer document
    // is legitimate - and if somebody else has moved the very card being undone, the server refuses it with a
    // conflict, which is the honest outcome rather than a silently discarded history.
    return true;
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) {
      this.state = this.queue.length > 0 || this.revision !== this.savedRevision ? "offline" : "clean";
    } else if (this.state === "offline") {
      this.state = this.revision === this.savedRevision ? "clean" : "pending";
    }
  }

  get isOnline(): boolean {
    return this.online;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * 应用一条用户手势产生的命令。
   *
   * 返回 true 表示这次编辑已经被服务端接受（或已进入离线待发队列）。返回 false 表示没有落地，
   * 调用方**必须**把界面回退到文档的真实状态——这就是“失败写入不显示为保存成功”的落点。
   */
  async apply(command: CanvasCommand, label: string): Promise<boolean> {
    if (command.type === "move_shapes" && (!command.positions || command.positions.length === 0)) {
      // React Flow 在一次拖拽结束时会回调，即使坐标没变。写一条什么都不改的命令会让版本号凭空前进，
      // 并且给别人制造无意义的冲突，所以在客户端就拦掉。
      return true;
    }
    return this.submit(command, label, { recordHistory: true });
  }

  /**
   * 撤销：把服务端记录的逆命令当**新命令**应用。
   *
   * 不走“回退版本号”：命令日志是 append-only 的，撤销本身也是一条被记录的变更，这样“谁在什么时候
   * 撤销了什么”仍然可查、可回放。代价是撤销也会冲突——而这正是诚实的结果：如果别人已经改过文档，
   * 撤销就不该静默覆盖他。
   */
  async undo(): Promise<boolean> {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return false;
    if (entry.inverse.length === 0) {
      this.undoStack.pop();
      this.state = this.revision === this.savedRevision ? "clean" : this.state;
      return true;
    }
    const ok = await this.submitMany(entry.inverse, `撤销：${entry.label}`);
    if (ok) {
      this.undoStack.pop();
      this.redoStack.push(entry);
    }
    return ok;
  }

  async redo(): Promise<boolean> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return false;
    const ok = await this.submit(entry.command, `重做：${entry.label}`, { recordHistory: false });
    if (ok) {
      this.redoStack.pop();
      this.undoStack.push(entry);
    }
    return ok;
  }

  /**
   * 把若干条命令**依次**应用，任一条失败即停。
   *
   * 刻意不做成一个批量 RPC：撤销一次“删卡”包含恢复卡片与恢复连线两条命令，而每一条都必须落在同一个
   * 版本序列里，任何一条失败都要如实停下并把失败暴露给用户，而不是假装整批成功。
   */
  private async submitMany(commands: CanvasCommand[], label: string): Promise<boolean> {
    const applied: CanvasCommand[] = [];
    const inverses: CanvasCommand[] = [];
    for (const command of commands) {
      const before = this.undoStack.length;
      const ok = await this.submit(command, label, { recordHistory: false });
      if (!ok) {
        // 半途失败：已经生效的部分无法悄悄撤回（撤回本身也是写入，同样可能失败），
        // 只能把已生效部分记入历史，让用户看到“撤销只完成了一半”并决定下一步。
        if (applied.length > 0) {
          this.undoStack.push({ command: applied[0], inverse: inverses.flat(), label: `${label}（部分完成）` });
        }
        return false;
      }
      void before;
      applied.push(command);
      inverses.push(...(this.lastUndoCommands ?? []));
    }
    if (applied.length > 0) {
      this.undoStack.push({ command: applied[applied.length - 1], inverse: inverses, label });
    }
    this.redoStack = [];
    return true;
  }

  private lastUndoCommands: CanvasCommand[] | null = null;

  private async submit(command: CanvasCommand, label: string, options: { recordHistory: boolean }): Promise<boolean> {
    if (!this.online) {
      // 离线：不假装成功，也不悄悄丢弃。命令进队列，界面显示“未保存”。
      this.queue.push({ command, label });
      this.state = "offline";
      this.lastError = "离线：编辑尚未发送到服务端，当前不是已保存状态。";
      return true;
    }
    this.inFlight += 1;
    this.state = this.savedRevision === this.revision ? "saving" : "saving";
    try {
      const result = await rpc<CanvasCommandResult>("canvas.applyCommand", {
        canvas_id: this.canvasId,
        expected_revision: this.revision,
        client_id: this.clientId,
        command
      });
      this.lastUndoCommands = Array.isArray(result.undo_commands) ? result.undo_commands : [];
      this.revision = result.revision;
      this.savedRevision = result.revision;
      this.state = "saved";
      this.lastError = null;
      this.conflict = null;
      if (options.recordHistory) {
        this.undoStack.push({ command, inverse: this.lastUndoCommands, label });
        this.redoStack = [];
      }
      this.options.onApplied?.(result, command);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      if (error instanceof RpcError && error.isRevisionConflict) {
        // 冲突：**绝不重试**。重试等于用一份过期的文档覆盖别人已经落地的编辑。
        const match = /expected revision (\d+) but the document is at revision (\d+)/.exec(message);
        const actual = match ? Number(match[2]) : this.revision;
        this.conflict = { expected: match ? Number(match[1]) : this.revision, actual, message };
        this.state = "conflict";
        this.options.onConflict?.(this.conflict);
      } else {
        this.state = "failed";
      }
      return false;
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.state === "saving") {
        this.state = this.revision === this.savedRevision ? "saved" : "pending";
      }
    }
  }

  /** 网络恢复后把离线队列依次发出。仍然逐条走版本检查，冲突照样如实报告。 */
  async flushQueue(): Promise<boolean> {
    if (!this.online || this.queue.length === 0) return this.queue.length === 0;
    const pending = [...this.queue];
    this.queue = [];
    for (const item of pending) {
      const ok = await this.submit(item.command, item.label, { recordHistory: true });
      if (!ok) return false;
    }
    return true;
  }

  /** 某条命令是否为冲突（供页面决定是否显示“重新载入”）。 */
  get hasConflict(): boolean {
    return this.conflict !== null;
  }
}

/**
 * 把一组卡片的移动翻译成**一条** move_shapes 命令。
 *
 * 为什么在拖拽结束时才调用它：拖动过程中每帧写一次会在一次拖拽里产生几十次写入，放大冲突面，
 * 也把命令日志淹掉。验收条款要的是“拖动结束合并写”，所以这里拿到的是一次拖拽的最终坐标集合。
 */
export function moveCommandFromNodes(nodes: { id: string; position: { x: number; y: number } }[]): CanvasCommand | null {
  const positions = nodes.map((node) => ({ shape_id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) }));
  if (positions.length === 0) return null;
  return { type: "move_shapes", positions };
}

/**
 * 复制：为一组已有卡片生成 create_shapes 负载。
 *
 * 新 id 在客户端生成，并写在负载里，因此“复制 → 撤销 → 重做”三步之后 id 仍然一致。
 * subject 引用被完整继承：复制一张资产卡，副本指向同一个资产版本——这正是画布上多参考输入的用法
 * （同一素材出现在多个镜头旁），而不是把素材本身复制一份。
 */
export function copyCommandFromShapes(
  shapes: { shape_id: string; shape_type: string; subject_type?: string; subject_id?: string; title?: string; x: number; y: number; width?: number; height?: number; rotation?: number; z_index?: number; props?: Record<string, unknown> }[],
  offset = { x: 32, y: 32 },
): { command: CanvasCommand; newIds: string[]; idMap: Record<string, string> } {
  const newIds: string[] = [];
  const idMap: Record<string, string> = {};
  const payload = shapes.map((shape) => {
    const shapeId = clientObjectId("shape");
    newIds.push(shapeId);
    idMap[shape.shape_id] = shapeId;
    return {
      shape_id: shapeId,
      shape_type: shape.shape_type,
      subject_type: shape.subject_type,
      subject_id: shape.subject_id ?? null,
      title: shape.title ? `${shape.title} 副本` : undefined,
      // The copy is offset from its source so pasted cards are visible rather than stacked exactly underneath.
      x: Math.round(shape.x + offset.x),
      y: Math.round(shape.y + offset.y),
      width: shape.width,
      height: shape.height,
      rotation: shape.rotation,
      z_index: shape.z_index,
      props: shape.props
    };
  });
  return { command: { type: "create_shapes", shapes: payload }, newIds, idMap };
}
