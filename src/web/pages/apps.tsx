import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Link2, LoaderCircle, Plus, X } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import {
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
} from '../lib/secondary-pages';
import { usePageData } from '../hooks/use-page-data';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loading,
  Notice,
} from '../components/ui';

const logos = new Set([
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'notion',
  'linear',
]);

function ServiceLogo({ slug }: { slug: string }) {
  return logos.has(slug) ? (
    <img src={`/logos/${slug}.svg`} alt="" width={24} height={24} />
  ) : (
    <Link2 size={24} aria-hidden="true" />
  );
}

function accountLabel(account: Connection) {
  const identity = connectionIdentity(account);
  return account.slug === 'notion' && identity.secondary
    ? `${identity.primary} · ${identity.secondary}`
    : (identity.secondary ?? identity.primary);
}

export function ConnectedAccount({
  account,
  busy,
  onDisconnect,
}: {
  account: Connection;
  busy: boolean;
  onDisconnect(trigger: HTMLButtonElement): void;
}) {
  const issue = connectionIssue(account);
  const label = accountLabel(account);
  return (
    <div className="compact-account">
      <div className="compact-account-details">
        <span className="compact-account-name">{label}</span>
        {issue && (
          <p className="compact-account-issue">
            <AlertCircle size={12} aria-hidden="true" />
            {issue}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="account-disconnect"
        data-disconnect-account={account.connectionId}
        aria-label={`Disconnect ${label} from ${account.name}`}
        title="Disconnect account"
        disabled={busy}
        onClick={(event) => onDisconnect(event.currentTarget)}
      >
        <X size={15} aria-hidden="true" />
      </Button>
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
  const [disconnectAccount, setDisconnectAccount] = useState<Connection | null>(null);
  const [disconnectError, setDisconnectError] = useState('');
  const page = useRef<HTMLDivElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogService = useRef('');
  const actionRequest = useRef<AbortController | null>(null);
  const groups = connectionGroups(connections ?? []);
  const connected = groups.filter((group) => group.accounts.length);
  const available = groups.filter((group) => !group.accounts.length);
  useEffect(() => () => actionRequest.current?.abort(), []);
  async function connect(connection: Connection) {
    if (actionRequest.current || busy) return;
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(`connect:${connection.slug}`);
    setError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        { method: 'POST', body: JSON.stringify({ returnTo: 'apps' }), signal: request.signal },
      );
      if (request.signal.aborted) return;
      window.location.assign(connectionUrl(result.url, window.location.origin));
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(errorMessage(cause));
      setBusy('');
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
    }
  }
  async function disconnect() {
    const connection = disconnectAccount;
    if (!connection?.connectionId || actionRequest.current || busy) return;
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(`disconnect:${connection.connectionId}`);
    setDisconnectError('');
    try {
      await api(
        `/api/apps/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(connection.connectionId)}/disconnect`,
        {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        },
      );
      if (request.signal.aborted) return;
      update((current) =>
        current ? removeConnection(current, connection.connectionId!) : current,
      );
      setDisconnectAccount(null);
      void refresh();
    } catch (cause) {
      if (request.signal.aborted) return;
      setDisconnectError(errorMessage(cause));
      void refresh();
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
      if (!request.signal.aborted) setBusy('');
    }
  }
  function cards(items: typeof groups) {
    return (
      <div className="app-grid">
        {items.map(({ service, accounts }) => (
          <article
            key={service.slug}
            className={`app-card${accounts.length ? ' has-accounts' : ''}`}
            aria-labelledby={`app-${service.slug}`}
          >
            <div className="app-card-summary">
              <ServiceLogo slug={service.slug} />
              <div className="app-card-copy">
                <h3 id={`app-${service.slug}`}>{service.name}</h3>
                <p className="app-card-description">{service.description}</p>
                {service.status === 'not_configured' && (
                  <p className="app-card-unavailable">Sign-in unavailable</p>
                )}
              </div>
              <Button
                variant={accounts.length ? 'ghost' : 'outline'}
                size={accounts.length ? 'icon' : 'sm'}
                className={accounts.length ? 'app-add-account' : 'app-connect'}
                data-connect-service={service.slug}
                aria-label={
                  accounts.length ? `Add ${service.name} account` : `Connect ${service.name}`
                }
                aria-busy={busy === `connect:${service.slug}`}
                title={accounts.length ? `Add ${service.name} account` : undefined}
                disabled={service.status === 'not_configured' || Boolean(busy)}
                onClick={() => void connect(service)}
              >
                {busy === `connect:${service.slug}` ? (
                  accounts.length ? (
                    <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  ) : (
                    'Opening…'
                  )
                ) : accounts.length ? (
                  <Plus size={15} aria-hidden="true" />
                ) : (
                  'Connect'
                )}
              </Button>
            </div>
            {accounts.length > 0 && (
              <div className="app-card-accounts">
                {accounts.map((account) => (
                  <ConnectedAccount
                    key={account.connectionId}
                    account={account}
                    busy={Boolean(busy)}
                    onDisconnect={(trigger) => {
                      dialogTrigger.current = trigger;
                      dialogService.current = account.slug;
                      setDisconnectError('');
                      setDisconnectAccount(account);
                    }}
                  />
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page apps-page" ref={page}>
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/apps" />
          <p>Your tools, connected to Otto.</p>
        </div>
      </header>
      {(error || loadError) && <Notice>{error || loadError}</Notice>}
      {!connections ? (
        loading ? (
          <Loading label="Checking apps…" />
        ) : null
      ) : (
        <>
          {connected.length > 0 && (
            <section className="apps-group" aria-labelledby="apps-connected">
              <h2 id="apps-connected">Connected apps</h2>
              {cards(connected)}
            </section>
          )}
          {available.length > 0 && (
            <section className="apps-group" aria-labelledby="apps-available">
              <h2 id="apps-available">{connected.length ? 'More apps' : 'Available apps'}</h2>
              {cards(available)}
            </section>
          )}
        </>
      )}
      <Dialog
        open={Boolean(disconnectAccount)}
        onOpenChange={(open) => {
          if (!open && !busy) setDisconnectAccount(null);
        }}
      >
        <DialogContent
          className="app-disconnect-dialog"
          aria-busy={Boolean(busy)}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-keep-account]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = dialogTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else
              Array.from(
                page.current?.querySelectorAll<HTMLButtonElement>('[data-connect-service]') ?? [],
              )
                .find((button) => button.dataset.connectService === dialogService.current)
                ?.focus();
          }}
        >
          <DialogTitle>Disconnect from {disconnectAccount?.name}?</DialogTitle>
          <DialogDescription>
            {disconnectAccount && accountLabel(disconnectAccount)}
            <span>Otto will lose access to this account. You can connect it again later.</span>
          </DialogDescription>
          {disconnectError && <Notice>{disconnectError}</Notice>}
          <div className="app-disconnect-actions">
            <Button
              data-keep-account
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => setDisconnectAccount(null)}
            >
              Keep account
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => void disconnect()}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
