import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, LockKeyhole } from 'lucide-react';
import { BrowserControl } from '../components/browser-control';
import { BrandMark } from '../components/brand';
import { Button, Field, Input, Notice } from '../components/ui';
import { api, errorMessage } from '../lib/api';

type Inspection = {
  origin: string;
  canSubmit: boolean;
  fields: Array<{ kind: 'identifier' | 'password' | 'otp'; label: string }>;
  methods: Array<{ label: string; kind: string; supported: boolean }>;
  issue: string | null;
};
type Attempt = {
  name: string;
  label: string;
  origin: string;
  state: 'pending' | 'saved';
  fromChat: boolean;
  expiresAt: string;
  inspection: Inspection | null;
};

export function BrowserConnection({ token }: { token: string }) {
  const base = `/api/browser-connections/attempt/${encodeURIComponent(token)}`;
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [fallbackReady, setFallbackReady] = useState(false);
  const [saveWarning, setSaveWarning] = useState(false);
  const [complete, setComplete] = useState(false);
  const [privateActive, setPrivateActive] = useState(false);
  const [browserPhase, setBrowserPhase] = useState<'opening' | 'open' | 'checking' | 'closed'>(
    'closed',
  );
  const [activity, setActivity] = useState<'credentials' | 'finish' | null>(null);
  const lastAutoFinish = useRef(0);
  const autoFinishFailures = useRef(0);
  const returnTo = attempt?.fromChat ? '/' : '/apps';
  const controlChanged = useCallback(
    (active: boolean, _privateView: boolean, phase: typeof browserPhase) => {
      setPrivateActive(active);
      setBrowserPhase(phase);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const value = await api<Attempt>(base, { cache: 'no-store' });
    setAttempt(value);
    return value;
  }, [base]);

  useEffect(() => {
    let active = true;
    void api<Attempt>(base, { cache: 'no-store' })
      .then((value) => {
        if (active) setAttempt(value);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    const clear = () => {
      setPassword('');
      setCode('');
    };
    window.addEventListener('blur', clear);
    return () => {
      active = false;
      window.removeEventListener('blur', clear);
    };
  }, [base]);

  useEffect(() => {
    if (!complete) return;
    const timer = window.setTimeout(() => window.location.assign(returnTo), 1100);
    return () => window.clearTimeout(timer);
  }, [complete, returnTo]);

  useEffect(() => {
    if (!submitted || complete || privateActive) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [submitted, complete, privateActive, refresh]);

  const inspection = attempt?.inspection;
  const ownOrigin = inspection?.canSubmit === true;
  const hasUsername = Boolean(
    ownOrigin && inspection?.fields.some((field) => field.kind === 'identifier'),
  );
  const hasPassword = Boolean(
    ownOrigin && inspection?.fields.some((field) => field.kind === 'password'),
  );
  const hasCode = Boolean(ownOrigin && inspection?.fields.some((field) => field.kind === 'otp'));
  const canUseForm =
    (hasUsername || hasPassword || hasCode) && !(hasCode && (hasUsername || hasPassword));
  const inspectionReady = Boolean(inspection);
  const formOrigin = inspection?.origin ?? attempt?.origin;
  const siteName = attempt?.label ?? attempt?.name ?? 'The website';
  useEffect(() => {
    if (complete || privateActive || canUseForm || !inspectionReady || browserPhase !== 'closed') {
      setFallbackReady(false);
      return;
    }
    const timer = window.setTimeout(() => setFallbackReady(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [complete, privateActive, canUseForm, inspectionReady, browserPhase]);

  useEffect(() => {
    if (!attempt || submitted || complete || privateActive || canUseForm) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [attempt, submitted, complete, privateActive, canUseForm, refresh]);

  const checking =
    !attempt ||
    activity !== null ||
    browserPhase === 'opening' ||
    browserPhase === 'checking' ||
    (!canUseForm && !fallbackReady && browserPhase !== 'open');
  const status =
    !attempt || browserPhase === 'opening'
      ? 'Opening the sign-in page'
      : activity === 'credentials'
        ? hasCode
          ? 'Sending your code'
          : 'Sending your sign-in details'
        : activity === 'finish' ||
            browserPhase === 'checking' ||
            (submitted && !canUseForm && !fallbackReady)
          ? `Checking the ${siteName} account page and saving the session`
          : browserPhase === 'open'
            ? `Waiting for the ${siteName} sign-in step`
            : hasCode
              ? `${siteName} asked for a code`
              : canUseForm
                ? `${siteName} asked for sign-in details`
                : fallbackReady
                  ? `${siteName} needs a website sign-in step`
                  : `Checking the ${siteName} sign-in options`;

  useEffect(() => {
    if (
      !submitted ||
      complete ||
      busy ||
      privateActive ||
      !inspection ||
      inspection.fields.length ||
      inspection.methods.length ||
      Date.now() - lastAutoFinish.current < 2000
    )
      return;
    lastAutoFinish.current = Date.now();
    void finish(true);
  }, [attempt, submitted, complete, busy, privateActive, inspection]);

  async function sendCredentials(event: FormEvent) {
    event.preventDefault();
    if (busy || !formOrigin) return;
    setBusy(true);
    setActivity('credentials');
    setError('');
    try {
      const result = await api<{
        status: 'submitted' | 'rejected';
        inspection: Inspection | null;
      }>(`${base}/credentials`, {
        method: 'POST',
        body: JSON.stringify({
          origin: formOrigin,
          ...(username && !hasCode ? { username } : {}),
          ...(password ? { password } : {}),
          ...(code ? { code } : {}),
        }),
        cache: 'no-store',
      });
      setPassword('');
      setCode('');
      if (result.status === 'rejected') {
        setError('The website rejected these details. Check them and try again.');
        return;
      }
      setSubmitted(true);
      setAttempt((current) => (current ? { ...current, inspection: result.inspection } : current));
      window.setTimeout(() => void refresh().catch(() => {}), 1200);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPassword('');
      setCode('');
      setBusy(false);
      setActivity(null);
    }
  }

  async function finish(automatic = false) {
    if (busy) return;
    setBusy(true);
    setActivity('finish');
    setError('');
    try {
      const result = await api<{ loginSaved?: boolean }>(`${base}/finish`, {
        method: 'POST',
        body: '{}',
        cache: 'no-store',
      });
      setSaveWarning(result.loginSaved === false);
      setComplete(true);
    } catch (cause) {
      const message = errorMessage(cause);
      if (
        !automatic ||
        (!message.includes('Still checking the signed-in page') &&
          ++autoFinishFailures.current >= 3)
      )
        setError(message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  return (
    <main className="browser-connection-page">
      <header className="browser-connection-top">
        <a className="browser-connection-brand" href={returnTo}>
          <BrandMark small />
          Otto
        </a>
        <a className="browser-connection-back" href={returnTo}>
          <ArrowLeft size={16} />
          {attempt?.fromChat ? 'Back to chat' : 'Back to Apps'}
        </a>
      </header>
      <div className="browser-connection-layout">
        <section className="browser-connection-stage" aria-label="Website sign-in">
          {complete || attempt?.state === 'saved' ? (
            <div className="browser-connection-success">
              <span className="browser-connection-success-mark">
                <Check size={28} />
              </span>
              <h1>Connected</h1>
              <p>Otto saved the website session.</p>
              {saveWarning && (
                <Notice kind="info">
                  The browser session is saved, but Vault could not save the login.
                </Notice>
              )}
              <a href={returnTo}>Return to {attempt?.fromChat ? 'chat' : 'Apps'}</a>
            </div>
          ) : (
            <>
              <div className="browser-connection-status" role="status" aria-live="polite">
                <span
                  className={
                    checking
                      ? 'browser-connection-status-dot working'
                      : 'browser-connection-status-dot'
                  }
                  aria-hidden="true"
                />
                <h1>
                  {checking
                    ? 'Working…'
                    : hasCode
                      ? 'Enter the code'
                      : canUseForm
                        ? 'Sign in'
                        : 'Website sign-in'}
                </h1>
                <p>{status}</p>
              </div>
              {attempt && canUseForm && !checking && (
                <form
                  className="browser-connection-form"
                  onSubmit={(event) => void sendCredentials(event)}
                >
                  <div className="browser-connection-address">
                    <LockKeyhole size={16} aria-hidden="true" />
                    <span>{formOrigin}</span>
                  </div>
                  {(hasUsername || hasPassword) && (
                    <Field
                      label={
                        inspection?.fields.find((field) => field.kind === 'identifier')?.label ??
                        'Account email or username'
                      }
                    >
                      <Input
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                        autoFocus
                        required={hasUsername}
                        disabled={busy}
                      />
                    </Field>
                  )}
                  {hasPassword && (
                    <Field label="Password">
                      <Input
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        type="password"
                        autoComplete="current-password"
                        required
                        disabled={busy}
                      />
                    </Field>
                  )}
                  {hasCode && (
                    <Field label="Verification code">
                      <Input
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{4,8}"
                        required
                        disabled={busy}
                      />
                    </Field>
                  )}
                  <Button type="submit" disabled={busy}>
                    {hasCode ? 'Send code' : 'Sign in'}
                  </Button>
                  <p className="browser-connection-note">
                    Your details stay out of chat and Otto’s model.
                  </p>
                </form>
              )}
              {error && <Notice>{error}</Notice>}
              <div
                className={
                  checking || canUseForm
                    ? 'browser-connection-browser hidden'
                    : 'browser-connection-browser'
                }
              >
                <BrowserControl
                  screen={null}
                  emptyMessage="The website needs a sign-in method Otto cannot show here."
                  live={false}
                  onEnlarge={() => {}}
                  onControlChange={controlChanged}
                  controlPath={`${base}/control`}
                  startLabel="Open website sign-in"
                  finishLabel="Done"
                  onCompleted={(result) => {
                    setSaveWarning(result.loginSaved === false);
                    setComplete(true);
                    void refresh().catch(() => {});
                  }}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
