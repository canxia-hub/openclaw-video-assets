import { FormEvent, useCallback, useEffect, useState } from "react";
import { GenerationJob, GenerationJobEvent, rpc } from "../lib/rpc";

const stateTone: Record<string, string> = {
  completed: "text-success",
  failed_recoverable: "text-warning",
  unknown_submission: "text-warning",
  manual_reconciliation: "text-danger",
  failed_permanent: "text-danger",
  cancelled_local: "text-text-faint",
};

export default function GenerationQueuePage() {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [events, setEvents] = useState<GenerationJobEvent[]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await rpc<GenerationJob[]>("generationJob.list", { limit: 100 });
      setJobs(next);
      setSelected((current) => current ?? next[0]?.job_id ?? null);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 3000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { setEvents([]); setEventCursor(0); }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await rpc<{events: GenerationJobEvent[]; cursor: number}>("generationJob.events", { job_id: selected, after_seq: eventCursor });
        if (stopped) return;
        if (result.events.length) {
          setEvents((current) => [...current, ...result.events.filter((item) => !current.some((old) => old.event_id === item.event_id))]);
          setEventCursor(result.cursor);
        }
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [selected, eventCursor]);

  const action = async (method: string, job_id: string) => {
    setBusy(true); setError(null);
    try { await rpc(method, { job_id }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      await rpc("generationJob.create", {
        idempotency_key: String(data.get("idempotency_key")), entry: String(data.get("entry")),
        provider: String(data.get("provider")), estimate_credits: Number(data.get("estimate_credits")),
        confirm_cost: true, request: { prompt_reference: String(data.get("prompt_reference") || "") }
      });
      event.currentTarget.reset(); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const current = jobs.find((job) => job.job_id === selected) ?? null;
  return <div className="space-y-5 p-5">
    <header><h1 className="text-lg font-semibold text-text-primary">生成队列</h1><p className="mt-1 text-xs text-text-secondary">持久 job、预算、提交对账与写回补偿。页面刷新或事件断连后从服务端日志恢复，不推测进度。</p></header>
    {error && <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
    <form onSubmit={create} className="grid gap-2 rounded-md border border-border-subtle bg-bg-raise1 p-3 md:grid-cols-5">
      <input name="idempotency_key" required placeholder="幂等键" className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs" />
      <input name="entry" required placeholder="入口，如 dreamina.video.generate" className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs" />
      <input name="provider" required placeholder="provider" className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs" />
      <input name="estimate_credits" required type="number" min="0" step="0.01" placeholder="预计费用" className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs" />
      <button disabled={busy} className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">确认费用并排队</button>
      <input name="prompt_reference" placeholder="提示词引用（不在列表展示正文）" className="rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs md:col-span-5" />
    </form>
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <section className="overflow-hidden rounded-md border border-border-subtle"><table className="w-full text-left text-xs"><thead className="bg-bg-raise2 text-text-faint"><tr><th className="p-2">Job</th><th>状态 / 阶段</th><th>费用</th><th>远端取消</th></tr></thead><tbody>{jobs.map((job)=><tr key={job.job_id} onClick={()=>setSelected(job.job_id)} className={`cursor-pointer border-t border-border-subtle ${selected===job.job_id?"bg-accent-dim":"hover:bg-bg-hover"}`}><td className="p-2 font-mono">{job.job_id.slice(0,16)}</td><td className={stateTone[job.state] ?? "text-text-secondary"}>{job.state} / {job.phase}</td><td>{job.actual_credits ?? job.estimated_credits} ({job.budget_state})</td><td>{job.remote_cancel_state}</td></tr>)}</tbody></table>{!jobs.length&&<div className="p-6 text-center text-xs text-text-faint">暂无任务</div>}</section>
      <aside className="space-y-3 rounded-md border border-border-subtle bg-bg-raise1 p-3">{current?<><div><div className="font-mono text-xs text-text-primary">{current.job_id}</div><div className="mt-1 text-xs text-text-secondary">provider request: {current.provider_request_id ?? "尚未确认"}</div></div><div className="flex flex-wrap gap-2"><button disabled={busy} onClick={()=>void action("generationJob.process",current.job_id)} className="rounded border border-border-subtle px-2 py-1 text-xs">运行</button><button disabled={busy} onClick={()=>void action("generationJob.reconcile",current.job_id)} className="rounded border border-border-subtle px-2 py-1 text-xs">对账未知提交</button><button disabled={busy} onClick={()=>void action("generationJob.resume",current.job_id)} className="rounded border border-border-subtle px-2 py-1 text-xs">恢复失败阶段</button><button disabled={busy} onClick={()=>void action("generationJob.cancel",current.job_id)} className="rounded border border-danger/40 px-2 py-1 text-xs text-danger">停止后续步骤</button></div>{current.local_cancel_requested&&<p className="text-xs text-warning">本地已停止后续步骤；远端状态为 {current.remote_cancel_state}，不代表退款。</p>}<ol className="max-h-72 space-y-2 overflow-y-auto">{events.map((item)=><li key={item.event_id} className="border-l border-border-strong pl-2 text-[11px]"><div>{item.seq}. {item.event_type}</div><div className="text-text-faint">{item.created_at}</div></li>)}</ol></>:<p className="text-xs text-text-faint">选择任务查看事件和恢复操作。</p>}</aside>
    </div>
  </div>;
}
