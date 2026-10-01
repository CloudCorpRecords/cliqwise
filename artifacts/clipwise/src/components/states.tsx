import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle } from 'lucide-react';
export function ErrorBlock({ onRetry, what }: { onRetry: () => void; what: string }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-destructive/40 bg-card p-5" role="alert" data-testid="error-block">
      <AlertTriangle className="h-5 w-5 text-destructive" />
      <p className="flex-1 text-sm">Could not load {what}.</p>
      <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry">Retry</Button>
    </div>
  );
}
export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-border p-10 text-center" data-testid="empty-state">
      <div className="mx-auto mb-4 flex h-12 items-end justify-center gap-1" aria-hidden>
        {[40, 80, 55, 100, 30].map((h, i) => <span key={i} className="w-1.5 rounded-full bg-primary/40" style={{ height: `${h}%` }} />)}
      </div>
      <p className="font-display text-2xl font-bold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
export const ListSkeleton = ({ n = 3 }: { n?: number }) => (
  <div className="space-y-3">{Array.from({ length: n }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}</div>
);
