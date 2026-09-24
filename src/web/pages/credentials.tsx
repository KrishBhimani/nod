import { useEffect, useState } from 'react';
import { Check, LockKeyhole, ShieldCheck, ArrowUpRight } from 'lucide-react';
import type { CredentialRequest } from '../../shared/contracts';
import { api, post, errorMessage } from '../lib/api';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { BrandMark } from '../components/brand';
import { originLabel } from './vault';

export function Credentials({ id }: { id: string }) {
  const [request, setRequest] = useState<CredentialRequest | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retried, setRetried] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [methodStarted, setMethodStarted] = useState(false);
  useEffect(() => {
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    void api<CredentialRequest>(`/api/credential-requests/${encodeURIComponent(id)}`)
      .then(setRequest)
      .catch(() => setError('This sign-in request is unavailable. Return to chat for a new link.'));
    return () => window.clearInterval(timer);
  }, [id]);
  const expired =
    request?.status === 'expired' || (request && new Date(request.expiresAt).getTime() < now);
  const filled = request?.status === 'filled';
  const fields = request?.fields ?? [];
  const username =
    request?.kind === 'identifier' || fields.some((field) => field.kind === 'identifier');
  const password = request?.kind === 'password';
  const credentialMethod = request?.methods?.find((method) => method.id === 'credentials');
  const canFill = credentialMethod?.supported !== false;
  const methods = request?.methods?.filter((method) => method.id !== 'credentials') ?? [];
  async function retry() {
    setSaving(true);
    setError('');
    try {
      await post(`/api/credential-requests/${encodeURIComponent(id)}/retry`);
      setRetried(true);
    } catch {
      setError('A new sign-in step could not be requested. Return to chat to check this task.');
    } finally {
      setSaving(false);
    }
  }
  async function choose(methodId: string) {
    setSaving(true);
    setError('');
    try {
      await post(`/api/credential-requests/${encodeURIComponent(id)}/method`, { methodId });
      setMethodStarted(true);
      setRequest((current) => (current ? { ...current, status: 'filled' } : current));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || saving) return;
    const form = event.currentTarget,
      data = new FormData(form);
    setSaving(true);
    setError('');
    try {
      const input =
        request.kind === 'otp'
          ? { code: data.get('code') }
          : request.kind === 'identifier'
            ? { username: data.get('username') }
            : {
                ...(username ? { username: data.get('username') } : {}),
                password: data.get('password'),
              };
      await post(`/api/credential-requests/${encodeURIComponent(id)}`, input);
      form.reset();
      setRequest((current) => (current ? { ...current, status: 'filled' } : current));
    } catch (cause) {
      form.reset();
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="credential-page">
      <a href="/" className="brand credential-brand">
        <BrandMark />
        <span>sidekick</span>
      </a>
      <div className="credential-card">
        {!request && !error ? (
          <Loading label="Opening secure sign-in…" />
        ) : filled ? (
          <div className="credential-complete">
            <div className="success-mark">
              <Check size={24} />
            </div>
            <h1>{methodStarted ? 'Continuing sign-in.' : 'Details submitted.'}</h1>
            <p>
              Sidekick is checking the next step. If the site needs anything else, you’ll get a new
              secure request in chat.
            </p>
            <Button asChild>
              <a href="/">Back to chat</a>
            </Button>
          </div>
        ) : expired ? (
          <div className="credential-complete">
            <LockKeyhole size={28} />
            <h1>{retried ? 'A new step is on its way.' : 'This link has expired.'}</h1>
            <p>
              {retried
                ? 'Return to chat for the next step.'
                : 'Ask Sidekick to check the sign-in page again.'}
            </p>
            {!retried && (
              <Button disabled={saving} onClick={() => void retry()}>
                {saving ? 'Requesting…' : 'Get a new sign-in link'}
              </Button>
            )}
            <Button variant="outline" asChild>
              <a href="/">Back to chat</a>
            </Button>
          </div>
        ) : (
          <>
            <div className="credential-symbol">
              <LockKeyhole size={22} />
            </div>
            <h1>{request?.kind === 'otp' ? 'Verify it’s you.' : 'Sign in securely.'}</h1>
            <p className="credential-intro">
              {request ? (
                <>
                  Continue on <strong>{originLabel(request.origin)}</strong>.
                </>
              ) : (
                'This link is only for you.'
              )}
            </p>
            {methods.length > 0 && (
              <div className="login-methods">
                {methods.map((method) => (
                  <div key={method.id}>
                    <Button
                      variant="outline"
                      disabled={saving || !method.supported}
                      onClick={() => void choose(method.id)}
                    >
                      {method.label}
                      {method.supported && <ArrowUpRight size={14} />}
                    </Button>
                    {!method.supported && method.reason && <small>{method.reason}</small>}
                  </div>
                ))}
              </div>
            )}
            {methods.some((method) => method.supported) && fields.length > 0 && (
              <div className="login-divider">or</div>
            )}
            {request && canFill && fields.length > 0 && (
              <form
                className="form-stack"
                autoComplete="off"
                onSubmit={(event) => void submit(event)}
              >
                {request.kind === 'otp' ? (
                  <Field
                    label={
                      fields.find((field) => field.kind === 'otp')?.label || 'Verification code'
                    }
                  >
                    <Input
                      name="code"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      maxLength={100}
                    />
                  </Field>
                ) : (
                  <>
                    {username && (
                      <Field
                        label={
                          fields.find((field) => field.kind === 'identifier')?.label ||
                          'Username or email'
                        }
                      >
                        <Input
                          name="username"
                          autoComplete="username"
                          autoFocus
                          required
                          maxLength={320}
                        />
                      </Field>
                    )}
                    {password && (
                      <Field label="Password">
                        <Input
                          name="password"
                          type="password"
                          autoComplete="current-password"
                          autoFocus={!username}
                          required
                          maxLength={8192}
                        />
                      </Field>
                    )}
                  </>
                )}
                <Button type="submit" disabled={saving}>
                  {saving ? 'Continuing…' : 'Continue'}
                </Button>
              </form>
            )}
            {credentialMethod?.supported === false && (
              <Notice kind="info">
                {credentialMethod.reason ?? 'This sign-in step needs another method.'}
              </Notice>
            )}
            {request && fields.length === 0 && !methods.some((method) => method.supported) && (
              <Notice kind="info">
                This page needs a different sign-in step. Return to chat to continue.
              </Notice>
            )}
          </>
        )}
        {error && <Notice>{error}</Notice>}
        <div className="credential-privacy">
          <ShieldCheck size={15} />
          <span>
            Your details go directly to this site through the secure vault. They aren’t sent to the
            chat or language model.
          </span>
        </div>
      </div>
    </main>
  );
}
