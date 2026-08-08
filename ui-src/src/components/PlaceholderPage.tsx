interface Props {
  title: string;
  phase: string;
  description: string;
  bullets?: string[];
}

/** P0 占位页：明确标注建设期次与规划能力，避免旧版"空壳无引导"问题。 */
export default function PlaceholderPage({ title, phase, description, bullets }: Props) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-[440px] rounded-lg border border-dashed border-border-strong bg-bg-raise1 p-8 text-center">
        <div className="mb-2 text-3xl text-text-faint">◌</div>
        <h1 className="mb-1 text-lg font-semibold text-text-primary">{title}</h1>
        <div className="mb-3 inline-block rounded-full border border-accent/40 bg-accent-dim px-2.5 py-0.5 text-[11px] text-accent">
          {phase} 交付
        </div>
        <p className="mb-4 text-sm leading-6 text-text-secondary">{description}</p>
        {bullets && bullets.length > 0 && (
          <ul className="space-y-1 text-left text-xs text-text-secondary">
            {bullets.map((b) => (
              <li key={b} className="flex gap-2">
                <span className="text-accent">·</span>
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
