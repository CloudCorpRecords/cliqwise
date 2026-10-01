import { Link } from 'wouter';
import { useUser } from '@clerk/react';
import { ChevronRight } from 'lucide-react';
import { useListJobs, getListJobsQueryKey } from '@workspace/api-client-react';
import { PageHead } from '@/components/app-shell';
import { StatusBadge } from '@/components/brand';
import { Empty, ErrorBlock, ListSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ago, fmtDur } from '@/lib/format';

export default function Jobs() {
  const { user } = useUser();
  const q = useListJobs({ query: { enabled: !!user?.id, queryKey: getListJobsQueryKey(), refetchInterval: (s) => (s.state.data?.some((j) => j.status === 'queued' || j.status === 'processing') ? 4000 : 20000) } });
  const jobs = [...(q.data ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return (
    <div>
      <PageHead eyebrow="History" title="Jobs">
        <Button asChild data-testid="link-new-job"><Link href="/dashboard">New job</Link></Button>
      </PageHead>
      {q.isLoading && <ListSkeleton />}
      {q.isError && <ErrorBlock what="jobs" onRetry={() => q.refetch()} />}
      {q.data && jobs.length === 0 && <Empty title="No jobs yet" body="Upload a recording or paste a link and your first clips will land here." action={<Button asChild><Link href="/dashboard">Start a job</Link></Button>} />}
      <ul className="space-y-3">
        {jobs.map((j) => (
          <li key={j.id}>
            <Link href={`/jobs/${j.id}`} data-testid={`row-job-${j.id}`} className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary">
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-lg font-bold">{j.title}</p>
                <p className="font-mono text-xs text-muted-foreground">{ago(j.createdAt)} - {fmtDur(j.durationSeconds)} - {j.clips.length}/{j.numberOfClips} clips - {j.creditsReserved} min{j.watermarked ? ' - watermarked' : ''}</p>
                {j.status === 'processing' && <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full origin-left bg-primary" style={{ width: '100%', transform: `scaleX(${j.progress / 100})` }} /></div>}
              </div>
              <StatusBadge status={j.status} />
              <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-1" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
