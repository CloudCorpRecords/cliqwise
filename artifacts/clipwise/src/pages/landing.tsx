import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { ArrowRight, Mic, Scissors, Smartphone, Plug } from 'lucide-react';
import { Logo, Eyebrow } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const rise = { initial: { opacity: 0, y: 24 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-60px' }, transition: { duration: 0.6, ease: [0.2, 0.7, 0.2, 1] as const } };

function Sample() {
  const bars = Array.from({ length: 44 }, (_, i) => 20 + ((i * 37) % 70));
  const picks = [[8, 14], [27, 36], [58, 66]];
  return (
    <div className="relative mx-auto w-full max-w-[420px]" aria-label="Illustrative product sample">
      <div className="rotate-[-3deg] rounded-2xl bg-card p-4 shadow-[8px_8px_0_hsl(var(--foreground))] border-2 border-foreground">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Illustrative sample - not a real job</p>
        <div className="mt-3 flex h-20 items-center gap-[3px]" aria-hidden>
          {bars.map((h, i) => {
            const hit = picks.some(([a, b]) => i >= a && i <= b);
            return <span key={i} className={`wave-bar w-full rounded-full ${hit ? 'bg-primary' : 'bg-foreground/25'}`} style={{ height: `${h}%`, animationDelay: `${(i % 9) * 0.1}s` }} />;
          })}
        </div>
        <p className="mt-2 font-mono text-[11px]">One long conversation, three moments selected</p>
      </div>
      <div className="relative z-10 -mt-4 ml-auto mr-2 w-44 rotate-[4deg] rounded-[1.6rem] border-[3px] border-foreground bg-sidebar p-2 shadow-[8px_8px_0_hsl(var(--primary))]">
        <div className="flex aspect-[9/16] flex-col justify-end rounded-[1.2rem] bg-gradient-to-b from-sidebar-accent to-sidebar p-3">
          <p className="font-display text-2xl font-extrabold leading-none text-secondary">THE PART <span className="text-primary">EVERYONE</span> REPLAYS</p>
          <div className="mt-3 h-1 rounded bg-sidebar-foreground/20"><div className="h-full w-2/3 rounded bg-primary" /></div>
        </div>
      </div>
    </div>
  );
}

const faqs = [
  ['What counts as a minute?', 'One credit is one minute of source video. The minutes are reserved when a job starts and shown in your usage ledger.'],
  ['Why are some clips watermarked?', 'Any job paid for with free monthly minutes is watermarked. Jobs paid with purchased minutes are not. Auto mode spends paid minutes first.'],
  ['What are the limits?', 'Files up to 4 GB and 3 hours. Ask for 1 to 10 clips per job, with bold, minimal, or karaoke captions.'],
  ['Can my AI assistant run it?', 'Yes. Generate an API key and connect any MCP client. Two tools: submit_video and get_job.'],
];

export default function Landing() {
  return (
    <div className="min-h-[100dvh] overflow-x-hidden">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" data-testid="link-sign-in"><Link href="/sign-in">Sign in</Link></Button>
          <Button asChild data-testid="link-sign-up-header"><Link href="/sign-up">Start free</Link></Button>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-24 pt-10 md:grid-cols-[1.2fr_1fr] md:pt-20">
        <div>
          <Eyebrow>MCP-first clipping for talkers</Eyebrow>
          <motion.h1 initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }} className="font-display mt-4 text-[clamp(3rem,9vw,7rem)] font-extrabold leading-[0.9]">
            The best <span className="relative inline-block text-primary">ninety seconds<span className="absolute -bottom-1 left-0 h-2 w-full bg-secondary -z-10" /></span> of your two-hour talk.
          </motion.h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">Clipwise finds the moments in a long conversation, cuts them vertical, captions them, and scores them. Use the web studio or let your AI assistant call it directly.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" data-testid="link-sign-up-hero"><Link href="/sign-up">Get 60 free minutes a month <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
            <Button asChild size="lg" variant="outline"><a href="#mcp">See the MCP tools</a></Button>
          </div>
        </div>
        <Sample />
      </section>

      <section className="bg-sidebar py-20 text-sidebar-foreground">
        <div className="mx-auto max-w-6xl px-5">
          <motion.div {...rise}><Eyebrow>How it works</Eyebrow><h2 className="font-display mt-2 max-w-2xl text-4xl font-extrabold md:text-6xl">Three steps, no timeline to scrub.</h2></motion.div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl bg-sidebar-border md:grid-cols-3">
            {[[Mic, 'Bring the recording', 'Upload a file or paste a link. Podcasts, interviews, livestreams, lectures.'], [Scissors, 'Moments get picked', 'Each clip is scored on hook, story, and payoff, then ranked by virality.'], [Smartphone, 'Vertical and captioned', 'Preview in the browser, download the file, post it.']].map(([I, t, d], i) => {
              const Icon = I as typeof Mic;
              return (
                <motion.div key={i} {...rise} transition={{ ...rise.transition, delay: i * 0.1 }} className="bg-sidebar p-8">
                  <span className="font-mono text-xs text-secondary">0{i + 1}</span>
                  <Icon className="my-4 h-7 w-7 text-primary" />
                  <h3 className="font-display text-2xl font-bold">{t as string}</h3>
                  <p className="mt-2 text-sm opacity-70">{d as string}</p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-5 py-24 md:grid-cols-2">
        <motion.div {...rise}>
          <Eyebrow>Scores you can read</Eyebrow>
          <h2 className="font-display mt-2 text-4xl font-extrabold md:text-5xl">Every clip arrives with its reasoning.</h2>
          <p className="mt-4 text-muted-foreground">Virality, hook, story, and payoff scores sit beside the transcript, so you know why a moment was chosen before you post it.</p>
        </motion.div>
        <motion.div {...rise} className="grid grid-cols-3 gap-3 self-center">
          {['bold', 'minimal', 'karaoke'].map((s, i) => (
            <div key={s} className="aspect-[9/14] rounded-xl border-2 border-foreground bg-card p-2 flex flex-col justify-end" style={{ transform: `rotate(${(i - 1) * 3}deg)` }}>
              <span className={`${s === 'bold' ? 'font-display text-lg font-extrabold uppercase' : s === 'minimal' ? 'text-[10px]' : 'font-display text-sm font-bold'} leading-tight`}>
                {s === 'karaoke' ? <><span className="bg-secondary px-0.5">word</span> by word</> : 'Caption style'}
              </span>
              <span className="mt-1 font-mono text-[10px] text-muted-foreground">{s}</span>
            </div>
          ))}
        </motion.div>
      </section>

      <section id="mcp" className="bg-secondary py-24 text-secondary-foreground">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 md:grid-cols-2">
          <motion.div {...rise}>
            <p className="font-mono text-xs uppercase tracking-[0.18em]"><Plug className="mr-1 inline h-3.5 w-3.5" />Direct AI-client access</p>
            <h2 className="font-display mt-2 text-4xl font-extrabold md:text-6xl">Ask your assistant to clip it.</h2>
            <p className="mt-4 max-w-md">Connect Claude, Cursor, or any MCP client with a bearer key. Two tools, nothing to learn.</p>
          </motion.div>
          <motion.pre {...rise} className="overflow-x-auto rounded-2xl bg-sidebar p-5 font-mono text-xs leading-relaxed text-sidebar-foreground">{`submit_video
  videoUrl | objectPath
  numberOfClips, captionStyle,
  creditSource

get_job
  id -> status, progress, clips[]`}</motion.pre>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-24">
        <motion.div {...rise}><Eyebrow>Transparent billing</Eyebrow><h2 className="font-display mt-2 text-4xl font-extrabold md:text-6xl">One credit, one minute.</h2></motion.div>
        <div className="mt-10 grid gap-4 md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="rounded-2xl border-2 border-foreground bg-card p-6"><p className="font-display text-5xl font-extrabold">60</p><p className="font-mono text-xs">free minutes every month, watermarked output</p></div>
          <div className="rounded-2xl bg-primary p-6 text-primary-foreground"><p className="font-display text-2xl font-bold">Paid packs</p><p className="mt-1 text-sm">No watermark. Spent first in Auto mode.</p></div>
          <div className="rounded-2xl bg-muted p-6"><p className="font-display text-2xl font-bold">Public ledger</p><p className="mt-1 text-sm">Every minute reserved or refunded, listed.</p></div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 pb-24">
        <h2 className="font-display mb-4 text-3xl font-extrabold">Questions</h2>
        <Accordion type="single" collapsible>
          {faqs.map(([q, a], i) => (
            <AccordionItem key={i} value={`f${i}`}><AccordionTrigger className="text-left font-display text-lg">{q}</AccordionTrigger><AccordionContent>{a}</AccordionContent></AccordionItem>
          ))}
        </Accordion>
      </section>

      <footer className="bg-sidebar px-5 py-16 text-center text-sidebar-foreground">
        <h2 className="font-display mx-auto max-w-2xl text-4xl font-extrabold md:text-6xl">Stop scrubbing. Start posting.</h2>
        <Button asChild size="lg" variant="secondary" className="mt-8" data-testid="link-sign-up-footer"><Link href="/sign-up">Create your account</Link></Button>
        <p className="mt-10 font-mono text-xs opacity-50">Clipwise</p>
      </footer>
    </div>
  );
}
