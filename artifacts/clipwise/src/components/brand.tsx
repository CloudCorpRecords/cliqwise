import { Link } from 'wouter';
export function Logo({ light = false, href = '/' }: { light?: boolean; href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2.5" data-testid="link-logo">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="h-8 w-8" />
      <span className={`font-display text-xl font-extrabold ${light ? 'text-[hsl(42_30%_94%)]' : ''}`}>Clipwise</span>
    </Link>
  );
}
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary">{children}</p>;
}
export function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground"><span>{label}</span><span>{Math.round(v)}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full origin-left rounded-full bg-primary transition-transform duration-700" style={{ transform: `scaleX(${v / 100})`, width: '100%' }} />
      </div>
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const m: Record<string, string> = {
    queued: 'bg-muted text-muted-foreground',
    processing: 'bg-secondary text-secondary-foreground',
    completed: 'bg-foreground text-background',
    failed: 'bg-destructive text-destructive-foreground',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${m[status] ?? m.queued}`} data-testid={`status-${status}`}>
      {status === 'processing' && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-rec" />}
      {status}
    </span>
  );
}
