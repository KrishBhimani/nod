import { useEffect, useId, useRef, useState } from 'react';
import { Copy, CreditCard, Eye, EyeOff, KeyRound, Trash2 } from 'lucide-react';
import type {
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultCardNumber,
  VaultCardSecurityCode,
  VaultListEntry,
} from '../../shared/contracts';
import { api } from '../lib/api';
import {
  clearVaultSecret,
  parseCardExpiry,
  VaultFields,
  type VaultSecretName,
} from './vault-item-form';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loading,
  Notice,
} from './ui';

function hasChanges(form: HTMLFormElement, details: VaultEntryDetails) {
  const data = new FormData(form);
  if (String(data.get('label') ?? '') !== details.label) return true;
  if (
    ['password', 'cardNumber', 'securityCode', 'removeSecurityCode'].some((name) => data.has(name))
  )
    return true;
  if (details.kind === 'login') return String(data.get('username') ?? '') !== details.username;
  const expiry = parseCardExpiry(data.get('expiry'));
  return (
    String(data.get('cardholder') ?? '') !== details.cardholder ||
    expiry?.expiryMonth !== details.expiryMonth ||
    expiry?.expiryYear !== details.expiryYear
  );
}

export function VaultDetails({
  entry,
  returnFocus,
  fallbackFocus,
  onClose,
  onSaved,
  onDeleted,
}: {
  entry: VaultEntry;
  returnFocus: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
  onClose(): void;
  onSaved(entry: VaultListEntry): void;
  onDeleted(id: string): void;
}) {
  const [details, setDetails] = useState<VaultEntryDetails | null>(null);
  const [detailsError, setDetailsError] = useState(false);
  const [secrets, setSecrets] = useState<Partial<Record<VaultSecretName, string>>>({});
  const [busy, setBusy] = useState<{
    action: 'identity' | 'show' | 'copy';
    name?: VaultSecretName;
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const formId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const previousDeleting = useRef(deleting);
  const active = useRef(false);
  const detailsRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);
  const isCard = entry.kind === 'card';
  const item = isCard ? 'card' : 'login';
  const identityName =
    details?.kind === 'login'
      ? (details.identifierLabel ?? 'Username')
      : isCard
        ? 'Cardholder name'
        : 'Username';

  function cancelAction() {
    actionGeneration.current += 1;
    actionRequest.current?.abort();
    actionRequest.current = null;
  }

  function hideRevealed() {
    cancelAction();
    setSecrets({});
    setBusy(null);
    setError('');
    setNotice('');
  }

  function hideSecrets() {
    hideRevealed();
    clearVaultSecret(editForm.current);
  }

  function updateDirty() {
    if (details && editForm.current && !saving) setDirty(hasChanges(editForm.current, details));
  }

  async function loadDetails() {
    detailsRequest.current?.abort();
    const request = new AbortController();
    detailsRequest.current = request;
    setDetailsError(false);
    try {
      const value = await api<VaultEntryDetails>(
        `/api/vault/${encodeURIComponent(entry.id)}/details`,
        { method: 'POST', body: '{}', cache: 'no-store', signal: request.signal },
      );
      if (!active.current || request.signal.aborted || detailsRequest.current !== request) return;
      if (value.id !== entry.id || value.kind !== entry.kind) throw new Error('Unexpected item');
      setDetails(value);
    } catch {
      if (active.current && !request.signal.aborted && detailsRequest.current === request)
        setDetailsError(true);
    }
  }

  useEffect(() => {
    active.current = true;
    void loadDetails();
    const hidden = () => {
      if (document.hidden) hideSecrets();
    };
    window.addEventListener('blur', hideSecrets);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      active.current = false;
      detailsRequest.current?.abort();
      saveRequest.current?.abort();
      cancelAction();
      clearVaultSecret(editForm.current);
      window.removeEventListener('blur', hideSecrets);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [entry.id]);

  useEffect(() => {
    if (previousDeleting.current === deleting) return;
    previousDeleting.current = deleting;
    footer.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [deleting]);

  useEffect(() => {
    if (formRevision) title.current?.focus();
  }, [formRevision]);

  function discardChanges() {
    hideSecrets();
    setFormRevision((value) => value + 1);
    setDirty(false);
  }

  async function saveChanges(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !details ||
      saving ||
      deleting ||
      !active.current ||
      !event.currentTarget.reportValidity() ||
      !hasChanges(event.currentTarget, details)
    )
      return;
    const data = new FormData(event.currentTarget);
    const expiry = isCard ? parseCardExpiry(data.get('expiry')) : null;
    if (isCard && !expiry) {
      setError('Enter an expiry date as MM / YYYY.');
      editForm.current?.querySelector<HTMLInputElement>('input[name="expiry"]')?.focus();
      return;
    }
    const username = String(data.get('username') ?? '');
    const cardholder = String(data.get('cardholder') ?? '');
    let replacement = String(data.get(isCard ? 'cardNumber' : 'password') ?? '');
    if (isCard && data.has('cardNumber') && !replacement.trim()) {
      setError('Enter the new card number or cancel this change.');
      event.currentTarget.querySelector<HTMLInputElement>('[name="cardNumber"]')?.focus();
      return;
    }
    let securityCode = data.has('removeSecurityCode')
      ? null
      : String(data.get('securityCode') ?? '');
    const hasSecurityCode =
      details.kind === 'card' &&
      (securityCode === null ? false : Boolean(securityCode) || details.hasSecurityCode);
    let body = JSON.stringify(
      isCard
        ? {
            kind: 'card',
            label: String(data.get('label') ?? ''),
            cardholder,
            ...expiry,
            ...(replacement ? { cardNumber: replacement } : {}),
            ...(securityCode === null || securityCode ? { securityCode } : {}),
          }
        : {
            label: String(data.get('label') ?? ''),
            username,
            ...(replacement ? { password: replacement } : {}),
          },
    );
    replacement = '';
    securityCode = '';
    data.delete('password');
    data.delete('cardNumber');
    data.delete('securityCode');
    hideSecrets();
    const request = new AbortController();
    saveRequest.current = request;
    const current = () =>
      active.current && !request.signal.aborted && saveRequest.current === request;
    setSaving(true);
    try {
      const pending = api<VaultEntry>(`/api/vault/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        body,
        cache: 'no-store',
        signal: request.signal,
      });
      body = '';
      const updated = await pending;
      if (!current()) return;
      if (
        updated.id !== entry.id ||
        updated.kind !== details.kind ||
        (updated.kind === 'login' && details.kind === 'login' && updated.origin !== details.origin)
      )
        throw new Error('Unexpected item');
      setDetails(
        updated.kind === 'card'
          ? { ...updated, cardholder, hasSecurityCode }
          : { ...updated, username },
      );
      setFormRevision((value) => value + 1);
      setDirty(false);
      setNotice(isCard ? 'Card updated.' : 'Login updated.');
      onSaved(updated.kind === 'card' ? updated : { ...updated, username });
    } catch {
      if (current()) setError(`This ${item} could not be updated. Try again.`);
    } finally {
      body = '';
      if (current()) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  async function remove() {
    if (saving || !active.current || !deleting) return;
    const request = new AbortController();
    saveRequest.current = request;
    const current = () =>
      active.current && !request.signal.aborted && saveRequest.current === request;
    setSaving(true);
    setError('');
    try {
      await api(`/api/vault/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        cache: 'no-store',
        signal: request.signal,
      });
      if (!current()) return;
      active.current = false;
      detailsRequest.current?.abort();
      hideSecrets();
      setDetails(null);
      onDeleted(entry.id);
    } catch {
      if (current()) setError(`This ${item} could not be deleted. Try again.`);
    } finally {
      if (current()) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  async function performAction(action: 'identity' | 'show' | 'copy', name?: VaultSecretName) {
    if (!details || busy || saving || deleting || !active.current || document.hidden) return;
    cancelAction();
    const generation = actionGeneration.current;
    const request = new AbortController();
    actionRequest.current = request;
    const current = () =>
      active.current &&
      generation === actionGeneration.current &&
      !request.signal.aborted &&
      !document.hidden;
    const secretLabel =
      name === 'securityCode'
        ? 'security code'
        : name === 'cardNumber'
          ? 'card number'
          : 'password';
    setBusy({ action, name });
    setError('');
    setNotice('');
    let value = '';
    try {
      if (action === 'identity')
        value =
          editForm.current?.querySelector<HTMLInputElement>(
            `input[name="${isCard ? 'cardholder' : 'username'}"]`,
          )?.value ?? '';
      else if (name && secrets[name] !== undefined) value = secrets[name]!;
      else if (name) {
        const endpoint =
          name === 'cardNumber'
            ? 'card-number'
            : name === 'securityCode'
              ? 'security-code'
              : 'password';
        const result = await api<VaultEntryPassword | VaultCardNumber | VaultCardSecurityCode>(
          `/api/vault/${encodeURIComponent(entry.id)}/${endpoint}`,
          { method: 'POST', body: '{}', cache: 'no-store', signal: request.signal },
        );
        if (!current()) return;
        value =
          'password' in result
            ? result.password
            : 'cardNumber' in result
              ? result.cardNumber
              : result.securityCode;
      }
      if (!current()) return;
      if (action === 'show' && name) {
        const revealed = value;
        setSecrets((previous) => ({ ...previous, [name]: revealed }));
      } else {
        const copying = navigator.clipboard.writeText(value);
        value = '';
        await copying;
        if (current())
          setNotice(
            action === 'identity'
              ? `${identityName} copied.`
              : `${secretLabel[0].toUpperCase()}${secretLabel.slice(1)} copied.`,
          );
      }
    } catch {
      if (current()) {
        setSecrets({});
        setError(
          action === 'show'
            ? `The ${secretLabel} could not be shown. Try again.`
            : 'Could not copy to the clipboard. Try again.',
        );
      }
    } finally {
      value = '';
      if (current()) {
        actionRequest.current = null;
        setBusy(null);
      }
    }
  }

  function secretControls(name: VaultSecretName, label: string, mask: string) {
    const value = secrets[name];
    return (
      <>
        {value === undefined ? (
          <span className="vault-password-mask" aria-label={`${label} hidden`}>
            {mask}
          </span>
        ) : (
          <span className="vault-detail-value vault-password-visible">{value}</span>
        )}
        <div className="vault-detail-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${value === undefined ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
            aria-pressed={value !== undefined}
            disabled={saving || (value === undefined && busy !== null)}
            onClick={() =>
              value === undefined ? void performAction('show', name) : hideRevealed()
            }
          >
            {value === undefined ? <Eye size={16} /> : <EyeOff size={16} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Copy ${label.toLowerCase()}`}
            disabled={saving || busy !== null}
            onClick={() => void performAction('copy', name)}
          >
            <Copy size={16} aria-hidden="true" />
          </Button>
        </div>
      </>
    );
  }

  function close() {
    active.current = false;
    detailsRequest.current?.abort();
    saveRequest.current?.abort();
    hideSecrets();
    setDetails(null);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="vault-details"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
          else if (fallbackFocus?.isConnected) fallbackFocus.focus();
        }}
      >
        <div className="dialog-heading">
          {isCard ? (
            <CreditCard size={22} aria-hidden="true" />
          ) : (
            <KeyRound size={22} aria-hidden="true" />
          )}
          <DialogTitle ref={title} tabIndex={-1}>
            {deleting ? `Delete this ${item}?` : (details?.label ?? entry.label)}
          </DialogTitle>
          <DialogDescription className="sr-only">
            View and manage this saved {item}.
          </DialogDescription>
        </div>
        {deleting && (
          <div className="vault-delete-confirmation">
            <p>
              <strong>{details?.label ?? entry.label}</strong> will be removed from your vault.
            </p>
            {error && <Notice>{error}</Notice>}
            <div ref={footer} className="dialog-actions">
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setError('');
                  setDeleting(false);
                }}
              >
                Keep {item}
              </Button>
              <Button variant="destructive" disabled={saving} onClick={() => void remove()}>
                {saving ? 'Deleting…' : `Delete ${item}`}
              </Button>
            </div>
          </div>
        )}
        <div hidden={deleting}>
          {entry.kind === 'login' && (
            <dl className="vault-detail-fields">
              <div>
                <dt>Website</dt>
                <dd className="vault-detail-value">{entry.origin}</dd>
              </div>
            </dl>
          )}
          {details ? (
            <form
              id={formId}
              key={formRevision}
              ref={editForm}
              onSubmit={(event) => void saveChanges(event)}
              onInput={updateDirty}
              className="form-stack vault-edit-form"
              autoComplete="off"
            >
              <VaultFields
                kind={entry.kind}
                details={details}
                disabled={saving}
                identityBusy={busy !== null}
                onCopyIdentity={() => void performAction('identity')}
                onSecretChange={() => {
                  hideRevealed();
                  updateDirty();
                }}
                secretControls={{
                  password: secretControls('password', 'Password', '••••••••'),
                  cardNumber: secretControls(
                    'cardNumber',
                    'Card number',
                    details.kind === 'card' ? `•••• ${details.last4}` : '••••',
                  ),
                  securityCode: secretControls('securityCode', 'Security code', '••••'),
                }}
              />
            </form>
          ) : detailsError ? (
            <div className="form-stack">
              <Notice>This {item} could not be opened. Try again.</Notice>
              <Button variant="outline" onClick={() => void loadDetails()}>
                Try again
              </Button>
            </div>
          ) : (
            <Loading label={`Opening ${item}…`} />
          )}
          {error && <Notice>{error}</Notice>}
          <p
            className={notice ? 'vault-detail-status' : 'sr-only'}
            role="status"
            aria-live="polite"
          >
            {notice}
          </p>
          <div ref={deleting ? undefined : footer} className="vault-detail-footer">
            <Button
              className="vault-delete-trigger"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                hideSecrets();
                setDeleting(true);
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete {item}
            </Button>
            <div className="vault-save-actions">
              {dirty ? (
                <>
                  <Button type="button" variant="ghost" disabled={saving} onClick={discardChanges}>
                    Cancel changes
                  </Button>
                  <Button type="submit" form={formId} disabled={saving}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="outline" onClick={close}>
                  Done
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
