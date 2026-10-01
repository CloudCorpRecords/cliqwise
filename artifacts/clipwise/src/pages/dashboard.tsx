import { useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/react';
import { Upload, Link2, Minus, Plus, Loader2 } from 'lucide-react';
import {
  useGetAccount, getGetAccountQueryKey, useGetSystemStatus, getGetSystemStatusQueryKey,
  useListJobs, getListJobsQueryKey, useSubmitVideo, useRequestUploadUrl, useHealthCheck,
  type VideoInput,
} from '@workspace/api-client-react';
import { PageHead } from '@/components/app-shell';
import { StatusBadge } from '@/components/brand';
import { ErrorBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { ago, bytes, dt, errMsg } from '@/lib/format';
import { uploadVideo, videoContentType } from '@/lib/video-upload';

const styles = [
  { v: 'bold', t: 'Bold', d: 'Big stacked words, high contrast.' },
  { v: 'minimal', t: 'Minimal', d: 'Quiet lower-third captions.' },
  { v: 'karaoke', t: 'Karaoke', d: 'Word-by-word highlight as spoken.' },
] as const;
const sources = [
  { v: 'auto', t: 'Auto', d: 'Spends paid minutes first so output is watermark-free. Falls back to free minutes, which are watermarked.' },
  { v: 'paid', t: 'Paid only', d: 'Paid minutes only. No watermark.' },
  { v: 'free', t: 'Free only', d: 'Monthly free minutes. Output is watermarked.' },
] as const;

export default function Dashboard() {
  const { user } = useUser();
  const on = !!user?.id;
  const qc = useQueryClient();
  const [, nav] = useLocation();
  const { toast } = useToast();
  const acc = useGetAccount({ query: { enabled: on, queryKey: getGetAccountQueryKey(), refetchInterval: 5000 } });
  const sys = useGetSystemStatus({ query: { enabled: on, queryKey: getGetSystemStatusQueryKey() } });
  const jobs = useListJobs({ query: { enabled: on, queryKey: getListJobsQueryKey(), refetchInterval: 5000 } });
  const health = useHealthCheck();
  const submit = useSubmitVideo();
  const ticket = useRequestUploadUrl();

  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [clips, setClips] = useState(5);
  const [style, setStyle] = useState<(typeof styles)[number]['v']>('bold');
  const [source, setSource] = useState<(typeof sources)[number]['v']>('auto');
  const [prog, setProg] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const maxBytes = sys.data?.maxFileBytes ?? 4294967296;
  const maxMin = Math.round((sys.data?.maxDurationSeconds ?? 10800) / 60);
  const a = acc.data;
  const ready = mode === 'file' ? !!file : /^https?:\/\//.test(url.trim());

  const pick = (f?: File | null) => {
    if (!f) return undefined;
    if (!f.size || !videoContentType(f)) { toast({ title: 'Choose a video file', description: 'Select a nonempty MP4, MOV, WebM, MKV, AVI or MPEG video.', variant: 'destructive' }); return undefined; }
    if (f.size > maxBytes) { toast({ title: 'File too large', description: `Limit is ${bytes(maxBytes)}.`, variant: 'destructive' }); return undefined; }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 200));
  };

  const go = async () => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const body: VideoInput = { title: title.trim() || undefined, numberOfClips: clips, captionStyle: style, creditSource: source };
      if (mode === 'file' && file) {
        const contentType = videoContentType(file);
        if (!contentType) throw new Error('Choose a supported video file.');
        const t = await ticket.mutateAsync({ data: { name: file.name, size: file.size, contentType } });
        setProg(0);
        await uploadVideo(t.uploadURL, file, contentType, setProg);
        setProg(null);
        body.objectPath = t.objectPath;
      } else body.videoUrl = url.trim();
      const job = await submit.mutateAsync({ data: body });
      qc.invalidateQueries({ queryKey: getListJobsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetAccountQueryKey() });
      nav(`/jobs/${job.id}`);
    } catch (e) {
      toast({ title: 'Could not start job', description: errMsg(e), variant: 'destructive' });
    } finally { setBusy(false); setProg(null); }
  };

  const active = (jobs.data ?? []).filter((j) => j.status === 'queued' || j.status === 'processing');
  const stat = (l: string, v: string | number | undefined) => (
    <div className="rounded-xl border bg-card p-4" data-testid={`stat-${l.toLowerCase().replace(/ /g, '-')}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{l}</p>
      {acc.isLoading ? <Skeleton className="mt-2 h-8 w-16" /> : <p className="font-display text-3xl font-extrabold">{v ?? '--'}</p>}
    </div>
  );

  return (
    <div>
      <PageHead eyebrow="Studio" title="Turn a talk into clips">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground" data-testid="status-api">
          <span className={`h-2 w-2 rounded-full ${health.isError ? 'bg-destructive' : health.data ? 'bg-secondary ring-2 ring-foreground' : 'bg-muted-foreground'}`} />
          API {health.isError ? 'unreachable' : health.data ? 'online' : 'checking'}
        </span>
      </PageHead>

      {acc.isError && <div className="mb-6"><ErrorBlock what="your account" onRetry={() => acc.refetch()} /></div>}
      <section className="mb-8 grid gap-4 md:grid-cols-[1.3fr_1fr_1fr]">
        <div className="rounded-xl bg-sidebar p-6 text-sidebar-foreground" data-testid="card-balance">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-60">Minutes available</p>
          <p className="font-display text-6xl font-extrabold text-secondary">{a?.totalCredits ?? '--'}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
            <div className="h-full origin-left bg-secondary transition-transform duration-700" style={{ width: '100%', transform: `scaleX(${a ? Math.min(1, a.freeCredits / a.monthlyAllowance) : 0})` }} />
          </div>
          <p className="mt-2 text-xs opacity-70">
            {a ? `${a.freeCredits} of ${a.monthlyAllowance} free minutes, resets ${dt(a.resetsAt)}. ${a.paidCredits} paid.` : 'Loading balance'}
          </p>
        </div>
        {stat('Minutes processed', a?.minutesProcessed)}
        <div className="grid grid-cols-3 gap-2 md:grid-cols-1">
          {stat('Clips', a?.clipsCreated)}{stat('Jobs', a?.jobsCount)}{stat('Active', a?.activeJobs)}
        </div>
      </section>

      {sys.data && !sys.data.pipelineReady && (
        <div className="mb-6 rounded-xl border border-primary/50 bg-card p-4 text-sm" role="status" data-testid="warn-pipeline">
          The processing pipeline is not ready yet. Jobs may stay queued until it is.
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-2xl border bg-card p-5 md:p-7" aria-labelledby="new-job">
          <h2 id="new-job" className="font-display text-2xl font-bold">New job</h2>
          <div className="mt-4 inline-flex rounded-full bg-muted p-1" role="tablist">
            {([['file', 'Upload file', Upload], ['url', 'Video URL', Link2]] as const).map(([k, l, I]) => (
              <button key={k} role="tab" aria-selected={mode === k} data-testid={`tab-${k}`} onClick={() => setMode(k)}
                className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition ${mode === k ? 'bg-foreground text-background' : 'text-muted-foreground'}`}>
                <I className="h-3.5 w-3.5" />{l}
              </button>
            ))}
          </div>

          <div className="mt-5">
            {mode === 'file' ? (
              <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
                className="rounded-xl border-2 border-dashed p-8 text-center transition hover:border-primary">
                <input ref={input} type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi,.mpeg,.mpg" className="sr-only" data-testid="input-file" onChange={(e) => pick(e.target.files?.[0])} />
                {file ? (
                  <p className="font-medium" data-testid="text-file">{file.name} <span className="font-mono text-xs text-muted-foreground">{bytes(file.size)}</span></p>
                ) : <p className="text-sm text-muted-foreground">Drop a recording here. Up to {bytes(maxBytes)} and {maxMin} minutes.</p>}
                <Button type="button" variant="outline" className="mt-3" onClick={() => input.current?.click()} data-testid="button-choose-file">{file ? 'Choose another' : 'Choose file'}</Button>
              </div>
            ) : (
              <div>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." inputMode="url" aria-label="Video URL" data-testid="input-url" />
                <p className="mt-2 text-xs text-muted-foreground">Use a direct video file URL or a public YouTube watch, Shorts or youtu.be link. Private, live and restricted videos are not supported.</p>
              </div>
            )}
          </div>

          <label className="mt-5 block text-sm font-medium" htmlFor="t">Title <span className="text-muted-foreground">(optional)</span></label>
          <Input id="t" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" data-testid="input-title" />

          <div className="mt-5 flex items-center justify-between">
            <span className="text-sm font-medium">Maximum clips</span>
            <div className="flex items-center gap-3">
              <Button type="button" size="icon" variant="outline" aria-label="Fewer clips" disabled={clips <= 1} onClick={() => setClips(clips - 1)} data-testid="button-clips-minus"><Minus className="h-4 w-4" /></Button>
              <span className="w-8 text-center font-display text-2xl font-extrabold" data-testid="text-clips">{clips}</span>
              <Button type="button" size="icon" variant="outline" aria-label="More clips" disabled={clips >= 10} onClick={() => setClips(clips + 1)} data-testid="button-clips-plus"><Plus className="h-4 w-4" /></Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Short recordings may return fewer clips. We only use moments available in your video.</p>

          <fieldset className="mt-5"><legend className="mb-2 text-sm font-medium">Caption style</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {styles.map((s) => (
                <label key={s.v} className={`cursor-pointer rounded-lg border p-3 transition has-[:focus-visible]:ring-2 ring-ring ${style === s.v ? 'border-primary bg-primary/10' : 'hover:border-foreground/40'}`}>
                  <input type="radio" name="style" className="sr-only" checked={style === s.v} onChange={() => setStyle(s.v)} data-testid={`radio-style-${s.v}`} />
                  <span className="font-display font-bold">{s.t}</span><span className="block text-xs text-muted-foreground">{s.d}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-5"><legend className="mb-2 text-sm font-medium">Minutes to spend</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {sources.map((s) => (
                <label key={s.v} className={`cursor-pointer rounded-lg border p-3 transition has-[:focus-visible]:ring-2 ring-ring ${source === s.v ? 'border-primary bg-primary/10' : 'hover:border-foreground/40'}`}>
                  <input type="radio" name="src" className="sr-only" checked={source === s.v} onChange={() => setSource(s.v)} data-testid={`radio-source-${s.v}`} />
                  <span className="font-display font-bold">{s.t}</span><span className="block text-xs text-muted-foreground">{s.d}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {prog !== null && (
            <div className="mt-5" aria-live="polite" data-testid="upload-progress">
              <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full origin-left bg-primary transition-transform" style={{ width: '100%', transform: `scaleX(${prog})` }} /></div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">Uploading {Math.round(prog * 100)}%</p>
            </div>
          )}
          <Button className="mt-6 w-full" size="lg" disabled={!ready || busy} onClick={go} data-testid="button-submit-job">
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{prog !== null ? 'Uploading' : 'Starting'}</> : 'Start clipping'}
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">Minutes are reserved against the source length when the job starts.</p>
        </section>

        <aside>
          <h2 className="font-display text-2xl font-bold">In the queue</h2>
          <div className="mt-3 space-y-2">
            {jobs.isLoading && <Skeleton className="h-16 w-full rounded-xl" />}
            {!jobs.isLoading && active.length === 0 && <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground" data-testid="text-no-active">Nothing running right now.</p>}
            {active.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className="block rounded-xl border bg-card p-4 hover:border-primary" data-testid={`card-active-${j.id}`}>
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{j.title}</span><StatusBadge status={j.status} /></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full origin-left bg-primary transition-transform duration-700" style={{ width: '100%', transform: `scaleX(${j.progress / 100})` }} /></div>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{j.stage} - {ago(j.createdAt)}</p>
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
