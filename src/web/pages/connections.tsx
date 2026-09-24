import { useEffect, useState } from 'react';
import { Check, Link2, Plus, RefreshCw, Unplug } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { Button, Loading, Notice } from '../components/ui';

const logos = new Set(['gmail', 'googlecalendar', 'googledrive', 'googlesheets', 'googledocs']);

function watchDescription(connection: Connection) {
  if (!connection.triggersEnabled) return 'Watching is off.';
  if (connection.triggersActive)
    return 'Watching for changes. Only useful updates need your attention.';
  if (connection.triggerStatus === 'unavailable')
    return 'Watching is on. Notification delivery still needs to be set up.';
  return 'Watching is on, but the subscription has not been confirmed.';
}

export function Connections() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    try {
      setConnections(await api<Connection[]>('/api/connections'));
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    void load();
    const focus = () => {
      void load();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  async function connect(connection: Connection) {
    setBusy(`connect:${connection.slug}`);
    setError('');
    try {
      const result = await post<{ url: string }>(
        `/api/connections/${encodeURIComponent(connection.slug)}/connect`,
      );
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('The sign-in address could not be verified.');
      window.location.assign(url.href);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy('');
    }
  }
  async function update(
    connection: Connection,
    action: 'disconnect' | 'triggers',
    enabled?: boolean,
  ) {
    if (!connection.connectionId) return;
    setBusy(`${action}:${connection.connectionId}`);
    setError('');
    try {
      await post(
        `/api/connections/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(connection.connectionId)}/${action}`,
        action === 'triggers' ? { enabled } : {},
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  const services = new Map<string, Connection[]>();
  for (const connection of connections ?? [])
    services.set(connection.slug, [...(services.get(connection.slug) ?? []), connection]);
  return (
    <div className="content-page">
      <header className="page-heading">
        <div>
          <h1>Connections</h1>
          <p>Your email, calendars, and files, in one conversation.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(busy)}
          onClick={() => void load()}
          aria-label="Refresh connections"
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      {error && <Notice>{error}</Notice>}
      {!connections ? (
        <Loading label="Checking connections…" />
      ) : (
        <div className="service-list">
          {[...services].map(([slug, entries]) => {
            const service = entries[0];
            const accounts = entries.filter((entry) => entry.connectionId);
            return (
              <section key={slug} className="service-row">
                <div className="connection-main">
                  {logos.has(slug) ? (
                    <img
                      className="service-logo"
                      src={`/logos/${slug}.svg`}
                      alt=""
                      width={32}
                      height={32}
                    />
                  ) : (
                    <Link2 size={30} aria-hidden="true" />
                  )}
                  <div className="connection-description">
                    <h2>{service.name}</h2>
                    <p>{service.description}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={service.status === 'not_configured' || Boolean(busy)}
                    onClick={() => void connect(service)}
                  >
                    <Plus size={14} />
                    {busy === `connect:${slug}`
                      ? 'Opening…'
                      : accounts.length
                        ? 'Add account'
                        : 'Connect'}
                  </Button>
                </div>
                {service.status === 'not_configured' && (
                  <p className="connection-setup">
                    Google connections need to be configured locally before you can sign in.
                  </p>
                )}
                {accounts.map((account) => (
                  <div key={account.connectionId} className="account-row">
                    <div className="connection-main">
                      <div className="connection-description">
                        <h3>
                          {account.accountName ??
                            account.accountEmail ??
                            'Account details unavailable'}
                        </h3>
                        {account.accountName && account.accountEmail && (
                          <p>{account.accountEmail}</p>
                        )}
                        <small className="account-status">
                          {account.status === 'connected' ? (
                            <>
                              <Check size={12} /> Connected
                            </>
                          ) : (
                            'Connection needs attention'
                          )}
                        </small>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => void update(account, 'disconnect')}
                        aria-label={`Disconnect ${account.accountEmail ?? account.accountName ?? service.name}`}
                      >
                        <Unplug size={14} />
                        {busy === `disconnect:${account.connectionId}` ? 'Removing…' : 'Disconnect'}
                      </Button>
                    </div>
                    {account.status === 'connected' && account.supportsTriggers && (
                      <div className="connection-trigger">
                        <div>
                          <span>Watch for changes</span>
                          <small>{watchDescription(account)}</small>
                        </div>
                        {account.triggerStatus === 'pending' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(busy)}
                            onClick={() => void update(account, 'triggers', true)}
                          >
                            Retry
                          </Button>
                        )}
                        <button
                          className={`toggle ${account.triggersEnabled ? 'toggle-on' : ''}`}
                          role="switch"
                          aria-checked={account.triggersEnabled}
                          aria-label={`Watch ${account.accountEmail ?? account.accountName ?? service.name} for changes`}
                          disabled={Boolean(busy)}
                          onClick={() => void update(account, 'triggers', !account.triggersEnabled)}
                        >
                          <span />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
