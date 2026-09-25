import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Link2, MoreHorizontal, Plus, Unplug } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import {
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
} from '../lib/secondary-pages';
import { usePageData } from '../hooks/use-page-data';
import { Button, Loading, Notice } from '../components/ui';
import { ConnectionMenu } from '../components/connection-menu';

const logos = new Set([
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'notion',
]);

function ServiceLogo({ slug }: { slug: string }) {
  return logos.has(slug) ? (
    <img src={`/logos/${slug}.svg`} alt="" width={24} height={24} />
  ) : (
    <Link2 size={24} aria-hidden="true" />
  );
}

export function ConnectedAccount({
  account,
  busy,
  onDisconnect,
}: {
  account: Connection;
  busy: boolean;
  onDisconnect(): void;
}) {
  const issue = connectionIssue(account);
  const identity = connectionIdentity(account);
  return (
    <div className="compact-account">
      <div className="compact-account-details">
        <div className="compact-account-identity">
          <span className="compact-account-name">{identity.primary}</span>
          {account.status === 'connected' && <Check size={13} aria-label="Connected" />}
        </div>
        {identity.secondary && (
          <small className="compact-account-email">{identity.secondary}</small>
        )}
        {issue && (
          <p className="compact-account-issue">
            <AlertCircle size={12} aria-hidden="true" />
            {issue}
          </p>
        )}
      </div>
      <ConnectionMenu
        label={`Actions for ${identity.primary}`}
        compact
        disabled={busy}
        trigger={<MoreHorizontal size={16} />}
      >
        {(close) => (
          <>
            <button
              role="menuitem"
              tabIndex={-1}
              className="connection-remove"
              onClick={() => {
                close();
                onDisconnect();
              }}
            >
              <Unplug size={14} />
              Disconnect account
            </button>
          </>
        )}
      </ConnectionMenu>
    </div>
  );
}

export function Apps() {
  const {
    data: connections,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<Connection[]>('/api/apps');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const page = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const connectionRequest = useRef<AbortController | null>(null);
  const groups = connectionGroups(connections ?? []);
  useEffect(() => () => connectionRequest.current?.abort(), []);
  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    const service = restoreFocus.current;
    restoreFocus.current = null;
    if (document.activeElement === document.body)
      Array.from(page.current?.querySelectorAll<HTMLButtonElement>('[data-connect-service]') ?? [])
        .find((button) => button.dataset.connectService === service)
        ?.focus();
  }, [busy]);
  async function connect(connection: Connection) {
    if (connectionRequest.current) return;
    const request = new AbortController();
    connectionRequest.current = request;
    setBusy(`connect:${connection.slug}`);
    setError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        { method: 'POST', body: '{}', signal: request.signal },
      );
      if (request.signal.aborted) return;
      window.location.assign(connectionUrl(result.url, window.location.origin));
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(errorMessage(cause));
      setBusy('');
    } finally {
      if (connectionRequest.current === request) connectionRequest.current = null;
    }
  }
  async function disconnect(connection: Connection) {
    if (!connection.connectionId) return;
    restoreFocus.current = page.current?.contains(document.activeElement) ? connection.slug : null;
    setBusy(`disconnect:${connection.connectionId}`);
    setError('');
    try {
      await post(
        `/api/apps/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(connection.connectionId)}/disconnect`,
      );
      update((current) =>
        current ? removeConnection(current, connection.connectionId!) : current,
      );
      void refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      void refresh();
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="content-page secondary-page apps-page" ref={page}>
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/apps" />
          <p>Connect the accounts you want Sidekick to use.</p>
        </div>
      </header>
      {(error || loadError) && <Notice>{error || loadError}</Notice>}
      {!connections ? (
        loading ? (
          <Loading label="Checking apps…" />
        ) : null
      ) : (
        <div className="app-grid">
          {groups.map(({ service, accounts }) => (
            <section
              key={service.slug}
              className="app-card"
              aria-labelledby={`app-${service.slug}`}
            >
              <div className="app-card-summary">
                <div className="app-card-heading">
                  <ServiceLogo slug={service.slug} />
                  <h2 id={`app-${service.slug}`}>{service.name}</h2>
                  {accounts.length > 1 && <span>{accounts.length} accounts</span>}
                </div>
                <p className="app-card-description">{service.description}</p>
              </div>
              {accounts.length > 0 && (
                <div className="app-card-accounts">
                  {accounts.map((account) => (
                    <ConnectedAccount
                      key={account.connectionId}
                      account={account}
                      busy={Boolean(busy)}
                      onDisconnect={() => void disconnect(account)}
                    />
                  ))}
                </div>
              )}
              <div className="app-card-actions">
                {service.status === 'not_configured' && <span>Sign-in unavailable</span>}
                <Button
                  variant="outline"
                  size="sm"
                  data-connect-service={service.slug}
                  aria-label={
                    accounts.length ? `Add ${service.name} account` : `Connect ${service.name}`
                  }
                  disabled={service.status === 'not_configured' || Boolean(busy)}
                  onClick={() => void connect(service)}
                >
                  <Plus size={14} aria-hidden="true" />
                  {busy === `connect:${service.slug}`
                    ? 'Opening…'
                    : accounts.length
                      ? 'Add account'
                      : 'Connect'}
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
