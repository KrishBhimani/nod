import { PageTitle } from '../components/page-title';
import { useRef, useState } from 'react';
import { usePageData } from '../hooks/use-page-data';
import { ArrowLeft, ChevronRight, CreditCard, Globe2, KeyRound, Plus } from 'lucide-react';
import type { VaultListEntry } from '../../shared/contracts';
import { VaultDetails } from '../components/vault-details';
import { formatCardExpiry, VaultItemForm } from '../components/vault-item-form';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loading,
  Notice,
} from '../components/ui';

export function originLabel(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return 'Website';
  }
}

export function Vault() {
  const {
    data: entries,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<VaultListEntry[]>('/api/vault');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<'login' | 'card' | null>(null);
  const [selected, setSelected] = useState<VaultListEntry | null>(null);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const addTitle = useRef<HTMLHeadingElement>(null);

  function save(entry: VaultListEntry) {
    update((current) => [entry, ...(current ?? []).filter((value) => value.id !== entry.id)]);
    void refresh();
  }

  return (
    <div className="content-page secondary-page">
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/vault" />
          <p>Your saved logins and payment cards.</p>
        </div>
        <span
          ref={(node) => {
            addTrigger.current = node?.querySelector('button') ?? null;
          }}
        >
          <Button
            size="sm"
            onClick={() => {
              setAdding(null);
              setOpen(true);
            }}
          >
            <Plus size={14} />
            Add to Vault
          </Button>
        </span>
      </header>
      {loadError && <Notice>Could not load your vault.</Notice>}
      {!entries ? (
        loading && <Loading label="Opening your vault…" />
      ) : entries.length ? (
        <div className="resource-list vault-list">
          {entries.map((entry) => (
            <div className="resource-row vault-row" key={entry.id}>
              <span className="resource-icon" aria-hidden="true">
                {entry.kind === 'card' ? <CreditCard size={20} /> : <Globe2 size={20} />}
              </span>
              <div className="resource-description">
                <h2>
                  <button
                    type="button"
                    className="vault-entry-trigger"
                    aria-label={`View ${entry.label}`}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      detailsTrigger.current = event.currentTarget;
                      setSelected(entry);
                    }}
                  >
                    {entry.label}
                  </button>
                </h2>
                <p className="vault-entry-meta">
                  {entry.kind === 'card' ? (
                    <>
                      <span>
                        {entry.brand} · •••• {entry.last4}
                      </span>
                      <span>Expires {formatCardExpiry(entry.expiryMonth, entry.expiryYear)}</span>
                    </>
                  ) : (
                    <>
                      <span>{originLabel(entry.origin)}</span>
                      {entry.username && (
                        <span className="vault-entry-username">{entry.username}</span>
                      )}
                    </>
                  )}
                </p>
              </div>
              <ChevronRight className="vault-entry-chevron" size={16} aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : (
        <div className="secondary-empty">
          <h2>Your vault is empty</h2>
          <p>Add a login or payment card to your vault.</p>
        </div>
      )}
      {selected && (
        <VaultDetails
          key={selected.id}
          entry={selected}
          returnFocus={detailsTrigger.current}
          fallbackFocus={addTrigger.current}
          onClose={() => setSelected(null)}
          onSaved={(entry) => {
            save(entry);
            setSelected(entry);
          }}
          onDeleted={(id) => {
            update((current) => current?.filter((value) => value.id !== id) ?? current);
            setSelected(null);
            void refresh();
          }}
        />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="vault-details"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            addTitle.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            addTrigger.current?.focus();
          }}
        >
          <div className="dialog-heading">
            {adding === 'card' ? (
              <CreditCard size={22} aria-hidden="true" />
            ) : (
              <KeyRound size={22} aria-hidden="true" />
            )}
            <DialogTitle ref={addTitle} tabIndex={-1}>
              {adding === 'card'
                ? 'Add a payment card'
                : adding === 'login'
                  ? 'Add a login'
                  : 'Add to Vault'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Choose what to save in your vault.
            </DialogDescription>
          </div>
          {adding ? (
            <>
              <Button
                className="vault-type-back"
                variant="ghost"
                size="sm"
                aria-label="Choose what to save"
                onClick={() => setAdding(null)}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Back
              </Button>
              <VaultItemForm
                key={adding}
                kind={adding}
                onSaved={(entry) => {
                  save(entry);
                  setOpen(false);
                }}
              />
            </>
          ) : (
            <div className="vault-item-types">
              <button type="button" aria-label="Login" onClick={() => setAdding('login')}>
                <KeyRound size={20} aria-hidden="true" />
                <span>
                  <strong>Login</strong>
                  <span>Username and password for a website</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Payment card" onClick={() => setAdding('card')}>
                <CreditCard size={20} aria-hidden="true" />
                <span>
                  <strong>Payment card</strong>
                  <span>Cardholder, number and expiry date</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
