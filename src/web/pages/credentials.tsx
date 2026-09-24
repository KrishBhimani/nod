import { useEffect, useState } from 'react';
import { Check, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import type { CredentialRequest } from '../../shared/contracts';
import { api, post } from '../lib/api';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { originLabel } from './vault';

export function Credentials({ id }: { id: string }) {
  const [request, setRequest] = useState<CredentialRequest | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retried, setRetried] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    void api<CredentialRequest>(`/api/credential-requests/${encodeURIComponent(id)}`)
      .then(setRequest)
      .catch(() =>
        setError('This request is unavailable. Return to your conversation for a new link.'),
      );
    return () => window.clearInterval(timer);
  }, [id]);
  const expired =
    request?.status === 'expired' || (request && new Date(request.expiresAt).getTime() < now);
  const filled = request?.status === 'filled';
  async function retry() {
    setSaving(true);
    setError('');
    try {
      await post(`/api/credential-requests/${encodeURIComponent(id)}/retry`);
      setRetried(true);
    } catch {
      setError(
        'A new sign-in step could not be requested. Return to your conversation to check this task.',
      );
    } finally {
      setSaving(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    setError('');
    try {
      const input =
        request.kind === 'otp'
          ? { code: data.get('code') }
          : { username: data.get('username'), password: data.get('password') };
      await post(`/api/credential-requests/${encodeURIComponent(id)}`, input);
      form.reset();
      setRequest((current) => (current ? { ...current, status: 'filled' } : current));
    } catch {
      form.reset();
      setError('The login could not be completed. Check your details and try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="credential-page">
      <a href="/" className="brand credential-brand">
        <span className="brand-mark">
          <Sparkles size={19} />
        </span>
        Sidekick
      </a>
      <div className="credential-card">
        {!request && !error ? (
          <Loading label="Opening your secure request…" />
        ) : filled ? (
          <div className="credential-complete">
            <div className="success-mark">
              <Check size={25} />
            </div>
            <h1>You’re all set.</h1>
            <p>
              Your details were passed to the login service.
              <br />
              The task can now continue.
            </p>
            <Button asChild>
              <a href="/">Back to the conversation</a>
            </Button>
          </div>
        ) : expired ? (
          <div className="credential-complete">
            <LockKeyhole size={30} />
            <h1>{retried ? 'A new sign-in step is on its way.' : 'This link has expired.'}</h1>
            <p>
              {retried
                ? 'Return to the conversation for the next step.'
                : 'Ask Sidekick to prepare a fresh sign-in link for this task.'}
            </p>
            {!retried && (
              <Button disabled={saving} onClick={() => void retry()}>
                {saving ? 'Requesting…' : 'Request a new sign-in link'}
              </Button>
            )}
            <Button variant="outline" asChild>
              <a href="/">Back to the conversation</a>
            </Button>
          </div>
        ) : (
          <>
            <div className="credential-symbol">
              <LockKeyhole size={23} />
            </div>
            <h1>{request?.kind === 'otp' ? 'One more step.' : 'A login is needed.'}</h1>
            <p className="credential-intro">
              {request ? (
                <>
                  Continue <strong>{request.label}</strong> on{' '}
                  <strong>{originLabel(request.origin)}</strong>.
                </>
              ) : (
                'Only you can provide these details.'
              )}
            </p>
            {request && (
              <form
                onSubmit={(event) => void submit(event)}
                className="form-stack"
                autoComplete="off"
              >
                {request.kind === 'otp' ? (
                  <Field label="Verification code">
                    <Input
                      name="code"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                      required
                    />
                  </Field>
                ) : (
                  <>
                    <Field label="Username or email">
                      <Input name="username" autoComplete="username" autoFocus />
                    </Field>
                    <Field label="Password">
                      <Input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </Field>
                  </>
                )}
                <Button type="submit" disabled={saving}>
                  {saving ? 'Continuing…' : 'Continue task'}
                </Button>
              </form>
            )}
          </>
        )}
        {error && <Notice>{error}</Notice>}
        <div className="credential-privacy">
          <ShieldCheck size={16} />
          <span>Sent to the login service. Never included in the chat or model prompt.</span>
        </div>
      </div>
      <p className="credential-footer">
        Close this page any time. Your other tasks can keep running.
      </p>
    </main>
  );
}
