import { useEffect, useState } from 'react';
import { Check, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { api, post } from '../lib/api';
import { Button, Loading, Notice } from '../components/ui';

interface Approval { id: string; action: string; args: Record<string, unknown>; status: string; }

function readableArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|authorization|access.?token|refresh.?token/i.test(key) ? '[Hidden]' : readableArgs(item)]));
  return value;
}

export function ApprovalPage({ id }: { id: string }) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (window.location.search || window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void api<Approval>(`/api/approvals/${encodeURIComponent(id)}`).then(setApproval).catch(() => setError('This approval is unavailable. Return to your conversation for the latest status.'));
  }, [id]);
  async function decide(approved: boolean) {
    setBusy(true); setError('');
    try { await post(`/api/approvals/${encodeURIComponent(id)}`, { approved }); setApproval(current => current ? { ...current, status: approved ? 'approved' : 'declined' } : current); }
    catch { setError('Your decision could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  const pending = approval?.status === 'pending';
  return <main className="credential-page"><a className="brand credential-brand" href="/"><span className="brand-mark"><Sparkles size={19} /></span>Sidekick</a><div className="credential-card approval-card">{!approval && !error ? <Loading label="Loading action details…" /> : approval && !pending ? <div className="credential-complete"><div className="success-mark"><Check size={24} /></div><h1>{approval.status === 'approved' ? 'Action approved.' : approval.status === 'expired' ? 'This approval expired.' : 'Action not approved.'}</h1><p>{approval.status === 'approved' ? 'Sidekick can now continue with this action.' : 'Return to your conversation to continue.'}</p><Button asChild><a href="/">Back to the conversation</a></Button></div> : <><div className="credential-symbol"><Send size={22} /></div><h1>A quick check with you.</h1><p className="credential-intro">Review this Google action before Sidekick continues.</p>{approval && <><div className="approval-operation"><span>Action</span><strong>{approval.action}</strong></div><pre className="approval-details" aria-label="Action details">{JSON.stringify(readableArgs(approval.args), null, 2)}</pre><div className="approval-actions"><Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Don’t allow</Button><Button disabled={busy} onClick={() => void decide(true)}>{busy ? 'Saving…' : 'Allow this action'}</Button></div></>}</>}{error && <Notice>{error}</Notice>}<div className="credential-privacy"><ShieldCheck size={16} /><span>Your decision applies to this action only.</span></div></div></main>;
}
