import { licenseMeta } from "../lib/format";

export function LicenseBadge({ status }: { status?: string }) {
  const meta = licenseMeta(status);
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] ${meta.className}`}>
      {meta.label}
    </span>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded border border-border-subtle bg-bg-raise2 px-1.5 py-0.5 text-[10px] text-text-secondary">
      {children}
    </span>
  );
}
