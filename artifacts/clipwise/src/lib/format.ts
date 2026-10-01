import { formatDistanceToNow, format } from 'date-fns';
export const fmtDur = (s?: number | null) => {
  if (s == null) return '--';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
};
export const ago = (d: string) => formatDistanceToNow(new Date(d), { addSuffix: true });
export const dt = (d: string) => format(new Date(d), 'MMM d, yyyy');
export const money = (c: number, cur: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(c / 100);
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
export async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}
export const errMsg = (e: unknown) => {
  const x = e as { data?: { error?: string; message?: string }; message?: string };
  return x?.data?.error || x?.data?.message || x?.message || 'Something went wrong';
};
