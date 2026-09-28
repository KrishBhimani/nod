import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AccountPreparationResponse, AccountUser } from '../../shared/account';
import type { Connection } from '../../shared/contracts';
import {
  integrationServiceIds,
  integrationServices,
  type IntegrationService,
} from '../../shared/integrations';
import { AccountAvatar } from '../components/account-avatar';
import { BrandMark } from '../components/brand';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';

export function Onboarding({
  user,
  onComplete,
  onLogout,
  canLogout,
}: {
  user: AccountUser;
  onComplete(): Promise<void>;
  onLogout(): void;
  canLogout: boolean;
}) {
  const { data, error: loadError, loading, refresh } = usePageData<Connection[]>('/api/apps');
  const [connecting, setConnecting] = useState<IntegrationService | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [preparation, setPreparation] = useState<'pending' | 'ready' | 'failed'>('pending');
  const preparationRequest = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const result = new URLSearchParams(window.location.search).get('connection');
    if (result === 'cancelled') setError('Connection cancelled. You can try again.');
    if (result === 'failed' || result === 'expired')
      setError('The app could not connect. Try again.');
    if (result) window.history.replaceState(null, '', window.location.pathname);
    void prepare();
    return () => {
      active.current = false;
      action.current?.abort();
      preparationRequest.current?.abort();
    };
  }, [user.id]);
  async function prepare() {
    preparationRequest.current?.abort();
    const request = new AbortController();
    preparationRequest.current = request;
    setPreparation('pending');
    try {
      const response = await api<AccountPreparationResponse>('/api/account/prepare', {
        method: 'POST',
        body: '{}',
        signal: request.signal,
      });
      if (response.ok !== true) throw new Error('Setup could not be completed.');
      if (!request.signal.aborted) setPreparation('ready');
    } catch {
      if (!request.signal.aborted) setPreparation('failed');
    } finally {
      if (preparationRequest.current === request) preparationRequest.current = null;
    }
  }
  async function connect(slug: IntegrationService) {
    if (action.current || saving) return;
    const request = new AbortController();
    action.current = request;
    setConnecting(slug);
    setError('');
    try {
      const response = await api<{ url: string }>(`/api/apps/${slug}/connect`, {
        method: 'POST',
        body: JSON.stringify({ returnTo: 'onboarding' }),
        signal: request.signal,
      });
      if (!request.signal.aborted)
        window.location.assign(connectionUrl(response.url, window.location.origin));
    } catch (cause) {
      if (!request.signal.aborted) {
        setError(errorMessage(cause));
        setConnecting(null);
      }
    } finally {
      if (action.current === request) action.current = null;
    }
  }
  async function complete() {
    if (saving || connecting || preparation !== 'ready') return;
    setSaving(true);
    setError('');
    try {
      await onComplete();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      if (active.current) setSaving(false);
    }
  }
  return (
    <main className="account-onboarding">
      <header>
        <div className="sign-in-brand">
          <BrandMark />
          <span>otto</span>
        </div>
        {canLogout && (
          <Button variant="ghost" onClick={onLogout}>
            Sign out
          </Button>
        )}
      </header>
      <div className="account-onboarding-content">
        <AccountAvatar user={user} large />
        <h1>Welcome{user.name.trim() ? `, ${user.name.trim().split(/\s+/)[0]}` : ''}.</h1>
        <p>Connect your apps.</p>
        {(error || loadError) && <Notice>{error || loadError}</Notice>}
        {loadError && (
          <Button variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        )}
        {loading && !data && <Loading />}
        <div className="onboarding-integrations" aria-busy={loading}>
          {data &&
            integrationServiceIds.map((slug) => {
              const service = integrationServices[slug];
              const rows = data.filter((connection) => connection.slug === slug);
              const connected = rows.some((connection) => connection.status === 'connected');
              const unavailable =
                !rows.length || rows.every((connection) => connection.status === 'not_configured');
              const reconnect = rows.some((connection) => connection.connectionId) && !connected;
              return (
                <article
                  key={slug}
                  className={`onboarding-integration${connected ? ' connected' : ''}`}
                  aria-labelledby={`onboarding-${slug}`}
                >
                  <img src={`/logos/${slug}.svg`} alt="" width={27} height={27} />
                  <h2 id={`onboarding-${slug}`}>{service.name}</h2>
                  {connected ? (
                    <span className="onboarding-connected">
                      <Check size={16} aria-hidden="true" />
                      Connected
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${reconnect ? 'Reconnect' : 'Connect'} ${service.name}`}
                      disabled={unavailable || Boolean(connecting) || saving}
                      onClick={() => void connect(slug)}
                    >
                      {connecting === slug ? (
                        <>
                          <LoaderCircle className="spin" size={14} aria-hidden="true" />
                          Opening…
                        </>
                      ) : reconnect ? (
                        'Reconnect'
                      ) : (
                        'Connect'
                      )}
                    </Button>
                  )}
                </article>
              );
            })}
        </div>
        {preparation === 'failed' && (
          <Notice>
            Setup could not be completed.{' '}
            <Button variant="ghost" onClick={() => void prepare()}>
              Try again
            </Button>
          </Notice>
        )}
        <div className="account-onboarding-actions">
          <Button
            disabled={saving || Boolean(connecting) || preparation !== 'ready'}
            onClick={() => void complete()}
          >
            {preparation === 'pending'
              ? 'Preparing…'
              : saving
                ? 'Opening Otto…'
                : 'Continue to Otto'}
          </Button>
          <Button
            variant="ghost"
            disabled={saving || Boolean(connecting) || preparation !== 'ready'}
            onClick={() => void complete()}
          >
            I’ll do this later
          </Button>
        </div>
      </div>
    </main>
  );
}
