import { useState } from 'react';
import { Link, useParams } from 'wouter';
import { useUser } from '@clerk/react';
import { ArrowLeft, Download, ChevronDown } from 'lucide-react';
import { useGetJob, getGetJobQueryKey, type Clip } from '@workspace/api-client-react';
import { ScoreBar, StatusBadge } from '@/components/brand';
import { Empty, ErrorBlock } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ago, fmtDur } from '@/lib/format';

function ClipCard({ c, i, wm }: { c: Clip; i: number; wm: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="overflow-hidden rounded-2xl border bg-card" data-testid={`card-clip-${c.id}`}>
      <div className="relative mx-auto aspect-[9/16] max-h-[460px] bg-sidebar">
        <video src={c.previewUrl} controls playsInline preload="metadata" className="h-full w-full object-contain" aria-label={`Preview of ${c.title}`} data-testid={`video-clip-${c.id}`} />
        <span className="absolute left-3 top-3 rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs font-medium text-secondary-foreground">#{i + 1}</span>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold leading-tight">{c.title}</h3>
          <div className="text-right"><p className="font-display text-3xl font-extrabold text-primary" data-testid={`text-virality-${c.id}`}>{Math.round(c.viralityScore)}</p><p className="font-mono text-[10px] uppercase text-muted-foreground">virality</p></div>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{fmtDur(c.durationSeconds)}{wm ? ' - watermarked' : ''}</p>
        <div className="grid grid-cols-3 gap-3"><ScoreBar label="Hook" value={c.hookScore} /><ScoreBar label="Story" value={c.storyScore} /><ScoreBar label="Payoff" value={c.payoffScore} /></div>
        <Button asChild className="w-full"><a href={c.downloadUrl} download data-testid={`link-download-${c.id}`}><Download className="mr-2 h-4 w-4" />Download</a></Button>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid={`button-transcript-${c.id}`} className="flex w-full items-center justify-between text-sm font-medium">
          Transcript <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && <p className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-sm leading-relaxed" data-testid={`text-transcript-${c.id}`}>{c.transcript}</p>}
      </div>
    </article>
  );
}

export default function JobDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { user } = useUser();
  const q = useGetJob(id, { query: { enabled: !!user?.id && !!id, queryKey: getGetJobQueryKey(id), refetchInterval: (s) => (s.state.data && (s.state.data.status === 'completed' || s.state.data.status === 'failed') ? false : 2500) } });
  const j = q.data;
  return (
    <div>
      <Link href="/jobs" className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back"><ArrowLeft className="h-4 w-4" />All jobs</Link>
      {q.isLoading && <Skeleton className="h-40 w-full rounded-2xl" />}
      {q.isError && <ErrorBlock what="this job" onRetry={() => q.refetch()} />}
      {j && (
        <>
          <div className="mb-8 rounded-2xl bg-sidebar p-6 text-sidebar-foreground md:p-8">
            <div className="flex flex-wrap items-center gap-3"><StatusBadge status={j.status} />{j.watermarked && <span className="rounded-full border border-sidebar-foreground/30 px-2.5 py-0.5 font-mono text-[11px]" data-testid="badge-watermark">Watermarked (free minutes)</span>}</div>
            <h1 className="mt-3 font-display text-3xl font-extrabold md:text-5xl" data-testid="text-job-title">{j.title}</h1>
            <p className="mt-2 font-mono text-xs opacity-70">Started {ago(j.createdAt)} - source {fmtDur(j.durationSeconds)} - {j.creditsReserved} min reserved - {j.captionStyle} captions</p>
            {(j.status === 'queued' || j.status === 'processing') && (
              <div className="mt-6" aria-live="polite" data-testid="job-progress">
                <div className="flex justify-between font-mono text-xs"><span className="capitalize">{j.stage}</span><span>{Math.round(j.progress)}%</span></div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-sidebar-accent"><div className="h-full origin-left rounded-full bg-secondary transition-transform duration-700" style={{ width: '100%', transform: `scaleX(${j.progress / 100})` }} /></div>
                <p className="mt-2 text-xs opacity-60">This page updates live. You can leave and come back.</p>
              </div>
            )}
            {j.status === 'failed' && <p className="mt-5 rounded-lg bg-destructive p-3 text-sm text-destructive-foreground" role="alert" data-testid="text-job-error">{j.error || 'This job failed.'}</p>}
          </div>
          {j.status === 'completed' && j.clips.length === 0 && <Empty title="No clips returned" body="The job finished without any clips." />}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[...j.clips].sort((a, b) => b.viralityScore - a.viralityScore).map((c, i) => <ClipCard key={c.id} c={c} i={i} wm={j.watermarked} />)}
          </div>
        </>
      )}
    </div>
  );
}
