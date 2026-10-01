import { type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useClerk, useUser } from '@clerk/react';
import { LayoutDashboard, Film, KeyRound, CreditCard, LogOut } from 'lucide-react';
import { useGetAccount, getGetAccountQueryKey } from '@workspace/api-client-react';
import { Logo } from '@/components/brand';

const nav = [
  { href: '/dashboard', label: 'Studio', icon: LayoutDashboard },
  { href: '/jobs', label: 'Jobs', icon: Film },
  { href: '/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/billing', label: 'Billing', icon: CreditCard },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data: acc } = useGetAccount({ query: { enabled: !!user?.id, queryKey: getGetAccountQueryKey(), refetchInterval: 8000 } });
  const base = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';
  const active = (h: string) => loc === h || loc.startsWith(h + '/');
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  return (
    <div className="min-h-[100dvh] md:flex">
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar p-5 text-sidebar-foreground md:sticky md:top-0 md:flex md:h-[100dvh]">
        <Logo light href="/dashboard" />
        <nav className="mt-10 flex flex-col gap-1" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} data-testid={`nav-${n.label.toLowerCase().replace(' ', '-')}`}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${active(n.href) ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_3px_0_0_hsl(var(--sidebar-primary))]' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60'}`}>
              <n.icon className="h-4 w-4" /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="rounded-lg bg-sidebar-accent p-4" data-testid="card-credits">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/60">Minutes left</p>
            <p className="font-display text-4xl font-extrabold text-secondary" data-testid="text-total-credits">{acc ? acc.totalCredits : '--'}</p>
            {acc && <p className="mt-1 font-mono text-[11px] text-sidebar-foreground/60">{acc.freeCredits} free / {acc.paidCredits} paid</p>}
          </div>
          <p className="truncate px-1 text-xs text-sidebar-foreground/60">{email}</p>
          <button type="button" data-testid="button-sign-out" onClick={() => signOut({ redirectUrl: base })}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/60">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-h-[100dvh] min-w-0 flex-1 flex-col pb-20 md:pb-0">
        <header className="flex items-center justify-between bg-sidebar px-4 py-3 md:hidden">
          <Logo light href="/dashboard" />
          <span className="rounded-full bg-sidebar-accent px-3 py-1 font-mono text-xs text-secondary" data-testid="text-total-credits-mobile">{acc ? `${acc.totalCredits} min` : '--'}</span>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-10 md:py-12">{children}</main>
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 bg-sidebar md:hidden" aria-label="Main mobile">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${active(n.href) ? 'text-secondary' : 'text-sidebar-foreground/70'}`}>
              <n.icon className="h-5 w-5" />{n.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
        <h1 className="font-display text-4xl font-extrabold md:text-5xl">{title}</h1>
      </div>
      {children}
    </div>
  );
}
