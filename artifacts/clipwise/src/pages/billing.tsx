import { useEffect } from 'react';
import { useUser } from '@clerk/react';
import {
  useListCreditPacks, getListCreditPacksQueryKey, useListActivity, getListActivityQueryKey,
  useCreateCheckout, useGetAccount, getGetAccountQueryKey, reconcileCheckout,
} from '@workspace/api-client-react';
import { PageHead } from '@/components/app-shell';
import { Empty, ErrorBlock, ListSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ago, dt, errMsg, money } from '@/lib/format';

export default function Billing() {
  const { user } = useUser();
  const on = !!user?.id;
  const { toast } = useToast();
  const packs = useListCreditPacks({ query: { enabled: on, queryKey: getListCreditPacksQueryKey() } });
  const act = useListActivity({ query: { enabled: on, queryKey: getListActivityQueryKey(), refetchInterval: 10000 } });
  const acc = useGetAccount({ query: { enabled: on, queryKey: getGetAccountQueryKey(), refetchInterval: 8000 } });
  const co = useCreateCheckout();
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const sessionId = p.get('session_id');
    if (!p.has('success') || !sessionId) return;
    const controller = new AbortController();
    toast({ title: 'Verifying checkout', description: 'Minutes are added only after Stripe confirms payment. Your balance refreshes automatically.' });
    void reconcileCheckout({ session_id: sessionId }, { signal: controller.signal })
      .then(async (result) => {
        await Promise.all([acc.refetch(), act.refetch()]);
        if (result.paid) toast({ title: 'Payment confirmed', description: 'Your processing minutes are available.' });
      }).catch(() => {
        if (!controller.signal.aborted) toast({ title: 'Payment verification pending', description: 'We will keep checking with Stripe. Your balance updates automatically once payment is confirmed.' });
      });
    return () => controller.abort();
  }, [toast]);
  const buy = (priceId: string) => co.mutate({ data: { priceId } }, {
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast({ title: 'Checkout unavailable', description: errMsg(e), variant: 'destructive' }),
  });
  const a = acc.data;
  return (
    <div>
      <PageHead eyebrow="Pay for minutes, nothing else" title="Billing" />
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {[['Free', a?.freeCredits], ['Paid', a?.paidCredits], ['Total', a?.totalCredits]].map(([l, v]) => (
          <div key={l as string} className="rounded-xl border bg-card p-4" data-testid={`balance-${(l as string).toLowerCase()}`}>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{l} minutes</p>
            <p className="font-display text-4xl font-extrabold">{v ?? '--'}</p>
            {l === 'Free' && a && <p className="text-xs text-muted-foreground">{a.monthlyAllowance} per month, resets {dt(a.resetsAt)}</p>}
          </div>
        ))}
      </div>
      <p className="mb-8 max-w-2xl rounded-xl bg-secondary p-4 text-sm text-secondary-foreground">One credit equals one minute of source video. Paid minutes never expire and produce watermark-free clips. Any job that uses free minutes is watermarked. Auto spends paid minutes first.</p>

      <h2 className="mb-3 font-display text-2xl font-bold">Minute packs</h2>
      {packs.isLoading && <ListSkeleton n={3} />}
      {packs.isError && <ErrorBlock what="packs" onRetry={() => packs.refetch()} />}
      {packs.data?.length === 0 && <Empty title="No packs available" body="Packs will show up here once Stripe is configured." />}
      <div className="grid gap-4 md:grid-cols-3">
        {packs.data?.map((p, i) => (
          <div key={p.id} data-testid={`card-pack-${p.id}`} className={`flex flex-col rounded-2xl border p-6 ${i === 1 ? 'bg-sidebar text-sidebar-foreground md:-translate-y-2' : 'bg-card'}`}>
            <p className="font-display text-xl font-bold">{p.name}</p>
            <p className="mt-4 font-display text-5xl font-extrabold">{p.credits}<span className="ml-1 text-base font-medium opacity-60">min</span></p>
            <p className="mt-1 font-mono text-xs opacity-70">{money(p.priceCents, p.currency)} - {money(p.priceCents / p.credits, p.currency)} per minute</p>
            <Button className="mt-6" variant={i === 1 ? 'secondary' : 'default'} disabled={co.isPending} onClick={() => buy(p.id)} data-testid={`button-buy-${p.id}`}>
              {money(p.priceCents, p.currency)} - Buy
            </Button>
          </div>
        ))}
      </div>

      <h2 className="mb-3 mt-12 font-display text-2xl font-bold">Usage ledger</h2>
      {act.isLoading && <ListSkeleton n={4} />}
      {act.isError && <ErrorBlock what="activity" onRetry={() => act.refetch()} />}
      {act.data?.length === 0 && <Empty title="Ledger is empty" body="Every reservation, refund, and purchase will be listed here." />}
      {!!act.data?.length && (
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="p-3">When</th><th className="p-3">Event</th><th className="p-3 text-right">Minutes</th></tr></thead>
            <tbody>
              {act.data.map((r) => (
                <tr key={r.id} className="border-t" data-testid={`row-activity-${r.id}`}>
                  <td className="whitespace-nowrap p-3 text-muted-foreground">{ago(r.createdAt)}</td>
                  <td className="p-3">{r.description} <span className="ml-1 font-mono text-[10px] uppercase text-muted-foreground">{r.type}</span></td>
                  <td className={`p-3 text-right font-mono ${r.credits < 0 ? 'text-destructive' : 'text-foreground'}`}>{r.credits > 0 ? '+' : ''}{r.credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
