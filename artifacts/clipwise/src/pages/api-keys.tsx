import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/react';
import { Copy, Check, KeyRound } from 'lucide-react';
import {
  useListApiKeys, getListApiKeysQueryKey, useGenerateApiKey, useRevokeApiKey,
  useGetSystemStatus, getGetSystemStatusQueryKey,
} from '@workspace/api-client-react';
import { PageHead } from '@/components/app-shell';
import { Empty, ErrorBlock, ListSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { ago, copyText, errMsg } from '@/lib/format';

function Snippet({ label, code, id }: { label: string; code: string; id: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 py-2 font-mono text-[11px] uppercase tracking-wider opacity-70">
        {label}
        <button type="button" data-testid={`button-copy-${id}`} onClick={async () => { await copyText(code); setOk(true); setTimeout(() => setOk(false), 1500); }} className="flex items-center gap-1 hover:text-secondary">
          {ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{ok ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 pb-4 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

export default function ApiKeys() {
  const { user } = useUser();
  const qc = useQueryClient();
  const { toast } = useToast();
  const keys = useListApiKeys({ query: { enabled: !!user?.id, queryKey: getListApiKeysQueryKey() } });
  const sys = useGetSystemStatus({ query: { enabled: !!user?.id, queryKey: getGetSystemStatusQueryKey() } });
  const gen = useGenerateApiKey();
  const rev = useRevokeApiKey();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const mcp = `${window.location.origin}${sys.data?.mcpPath ?? '/api/mcp'}`;
  const origin = window.location.origin;

  const create = () => gen.mutate({ data: { name: name.trim() } }, {
    onSuccess: (r) => { setSecret(r.key); setCopied(false); setName(''); qc.invalidateQueries({ queryKey: getListApiKeysQueryKey() }); },
    onError: (e) => toast({ title: 'Could not create key', description: errMsg(e), variant: 'destructive' }),
  });
  const doRevoke = () => target && rev.mutate({ id: target.id }, {
    onSuccess: () => { toast({ title: 'Key revoked' }); setTarget(null); qc.invalidateQueries({ queryKey: getListApiKeysQueryKey() }); },
    onError: (e) => toast({ title: 'Could not revoke', description: errMsg(e), variant: 'destructive' }),
  });
  const KEY = secret ?? 'cw_YOUR_KEY';
  const cfg = JSON.stringify({ mcpServers: { clipwise: { url: mcp, headers: { Authorization: `Bearer ${KEY}` } } } }, null, 2);
  const cli = `claude mcp add --transport http clipwise ${mcp} \\\n  --header "Authorization: Bearer ${KEY}"`;
  const upload = `curl -X POST ${origin}/api/storage/uploads/request-url \\\n  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\\n  -d '{"name":"talk.mp4","size":123456,"contentType":"video/mp4"}'\n# PUT the file bytes to uploadURL, then pass objectPath to submit_video`;

  return (
    <div>
      <PageHead eyebrow="Direct access" title="API keys" />
      <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
        <section>
          <div className="rounded-2xl border bg-card p-5">
            <h2 className="font-display text-xl font-bold">Generate a key</h2>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create(); }}>
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Desktop" aria-label="Key name" data-testid="input-key-name" />
              <Button type="submit" disabled={!name.trim() || gen.isPending} data-testid="button-generate-key">{gen.isPending ? 'Generating' : 'Generate'}</Button>
            </form>
            {secret && (
              <div className="mt-4 rounded-xl border-2 border-primary bg-primary/10 p-4" role="status" data-testid="panel-new-key">
                <p className="text-sm font-semibold">Copy this key now. It will not be shown again.</p>
                <code className="mt-2 block break-all rounded bg-sidebar p-3 font-mono text-xs text-secondary" data-testid="text-new-key">{secret}</code>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={async () => { setCopied(await copyText(secret)); }} data-testid="button-copy-key">{copied ? 'Copied' : 'Copy key'}</Button>
                  <Button size="sm" variant="outline" onClick={() => setSecret(null)} data-testid="button-dismiss-key">I have saved it</Button>
                </div>
              </div>
            )}
          </div>
          <div className="mt-6 space-y-2">
            {keys.isLoading && <ListSkeleton n={2} />}
            {keys.isError && <ErrorBlock what="keys" onRetry={() => keys.refetch()} />}
            {keys.data?.length === 0 && <Empty title="No keys yet" body="Generate one to connect Claude, Cursor, or any MCP client." />}
            {keys.data?.map((k) => (
              <div key={k.id} data-testid={`row-key-${k.id}`} className={`flex items-center gap-3 rounded-xl border bg-card p-4 ${k.revokedAt ? 'opacity-55' : ''}`}>
                <KeyRound className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{k.name}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{k.prefix}... - created {ago(k.createdAt)} - {k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : 'never used'}</p>
                </div>
                {k.revokedAt ? <span className="font-mono text-[11px] uppercase text-destructive">Revoked</span> :
                  <Button size="sm" variant="outline" onClick={() => setTarget({ id: k.id, name: k.name })} data-testid={`button-revoke-${k.id}`}>Revoke</Button>}
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="mcp">
          <h2 id="mcp" className="font-display text-2xl font-bold">Connect an AI client</h2>
          <p className="text-sm text-muted-foreground">Clipwise exposes exactly two MCP tools: <code className="font-mono">submit_video</code> and <code className="font-mono">get_job</code>. Authenticate with your key as a bearer token.</p>
          <Snippet id="url" label="Server URL" code={mcp} />
          <Snippet id="json" label="Client config (JSON)" code={cfg} />
          <Snippet id="cli" label="Claude Code" code={cli} />
          <p className="text-sm text-muted-foreground">To submit a local file, request an upload ticket, PUT the bytes to the returned URL, then call <code className="font-mono">submit_video</code> with the <code className="font-mono">objectPath</code>.</p>
          <Snippet id="upload" label="Upload ticket" code={upload} />
        </section>
      </div>
      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Revoke {target?.name}?</AlertDialogTitle><AlertDialogDescription>Clients using this key will stop working immediately. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep</AlertDialogCancel><AlertDialogAction onClick={doRevoke} data-testid="button-confirm-revoke">Revoke key</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
