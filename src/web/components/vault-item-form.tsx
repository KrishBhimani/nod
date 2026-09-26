import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { VaultEntry, VaultEntryDetails, VaultListEntry } from '../../shared/contracts';
import { api } from '../lib/api';
import { Button, Field, Input, Notice } from './ui';

export function formatCardExpiry(month: number, year: number) {
  return `${String(month).padStart(2, '0')} / ${year}`;
}

export function parseCardExpiry(value: FormDataEntryValue | null) {
  const match = String(value ?? '').match(/^\s*(0?[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\s*$/);
  if (!match) return null;
  return {
    expiryMonth: Number(match[1]),
    expiryYear: match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]),
  };
}

export function clearVaultSecret(form: HTMLFormElement | null) {
  form
    ?.querySelectorAll<HTMLInputElement>(
      'input[name="password"], input[name="cardNumber"], input[name="securityCode"]',
    )
    .forEach((input) => (input.value = ''));
}

export type VaultSecretName = 'password' | 'cardNumber' | 'securityCode';

function VaultSecretField({
  name,
  label,
  editing,
  saved = true,
  mask = '••••••••',
  disabled,
  controls,
  onChange,
}: {
  name: VaultSecretName;
  label: string;
  editing: boolean;
  saved?: boolean;
  mask?: string;
  disabled: boolean;
  controls?: React.ReactNode;
  onChange?(): void;
}) {
  const [mode, setMode] = useState<'keep' | 'replace' | 'remove'>('keep');
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const previous = useRef(mode);
  const notify = useRef(onChange);
  notify.current = onChange;
  useEffect(() => {
    if (previous.current === mode) return;
    previous.current = mode;
    if (mode === 'replace') input.current?.focus();
    else trigger.current?.querySelector<HTMLButtonElement>('[data-change-secret]')?.focus();
    notify.current?.();
  }, [mode]);
  if (editing && mode !== 'replace')
    return (
      <div className="field vault-secret-field">
        <span className="field-label">{label}</span>
        <div className="vault-secret-saved" ref={trigger}>
          {mode === 'remove' ? (
            <>
              <span className="vault-secret-empty">Will be removed</span>
              <input name="removeSecurityCode" type="hidden" value="true" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-change-secret
                disabled={disabled}
                onClick={() => setMode('keep')}
              >
                Cancel removal
              </Button>
            </>
          ) : (
            <>
              {saved ? (
                (controls ?? (
                  <span className="vault-password-mask" aria-label={`${label} hidden`}>
                    {mask}
                  </span>
                ))
              ) : (
                <span className="vault-secret-empty">Not saved</span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-change-secret
                aria-label={`${saved ? 'Change' : 'Add'} ${label.toLowerCase()}`}
                disabled={disabled}
                onClick={() => setMode('replace')}
              >
                {saved ? 'Change' : 'Add'}
              </Button>
              {name === 'securityCode' && saved && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove security code"
                  disabled={disabled}
                  onClick={() => setMode('remove')}
                >
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  return (
    <div className="vault-secret-field">
      <Field
        label={
          editing
            ? `New ${label.toLowerCase()}`
            : name === 'securityCode'
              ? `${label} (CVC/CVV, optional)`
              : label
        }
      >
        <Input
          ref={input}
          name={name}
          type="password"
          inputMode={name === 'password' ? undefined : 'numeric'}
          autoComplete={
            name === 'cardNumber'
              ? 'cc-number'
              : name === 'securityCode'
                ? 'cc-csc'
                : 'new-password'
          }
          maxLength={name === 'cardNumber' ? 32 : name === 'securityCode' ? 4 : 8192}
          pattern={name === 'securityCode' ? '[0-9]{3,4}' : undefined}
          required={editing || name !== 'securityCode'}
          disabled={disabled}
        />
      </Field>
      {editing && (
        <Button
          className="vault-secret-cancel"
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (input.current) input.current.value = '';
            setMode('keep');
          }}
        >
          Cancel change
        </Button>
      )}
    </div>
  );
}

export function VaultFields({
  kind,
  details,
  disabled,
  secretControls,
  onSecretChange,
  onCopyIdentity,
  identityBusy = false,
}: {
  kind: 'login' | 'card';
  details?: VaultEntryDetails;
  disabled: boolean;
  secretControls?: Partial<Record<VaultSecretName, React.ReactNode>>;
  onSecretChange?(): void;
  onCopyIdentity?(): void;
  identityBusy?: boolean;
}) {
  const identityLabel =
    details?.kind === 'login'
      ? (details.identifierLabel ?? 'Username')
      : kind === 'card'
        ? 'Cardholder name'
        : 'Username';
  return (
    <>
      <Field label="Name">
        <Input
          name="label"
          defaultValue={details?.label}
          placeholder={kind === 'card' ? 'For example, everyday card' : 'For example, work account'}
          required
          maxLength={100}
          disabled={disabled}
        />
      </Field>
      {kind === 'login' && !details && (
        <Field label="Website domain">
          <Input
            name="origin"
            placeholder="example.com"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={2048}
            disabled={disabled}
          />
        </Field>
      )}
      <div className="vault-identity-field">
        <Field label={identityLabel}>
          <Input
            name={kind === 'card' ? 'cardholder' : 'username'}
            defaultValue={details?.kind === 'card' ? details.cardholder : (details?.username ?? '')}
            autoComplete={kind === 'card' ? 'cc-name' : 'username'}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={kind === 'card' ? 200 : 320}
            required={kind === 'card'}
            disabled={disabled}
          />
        </Field>
        {onCopyIdentity && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Copy ${identityLabel.toLowerCase()}`}
            disabled={disabled || identityBusy}
            onClick={onCopyIdentity}
          >
            <Copy size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      <VaultSecretField
        name={kind === 'card' ? 'cardNumber' : 'password'}
        label={kind === 'card' ? 'Card number' : 'Password'}
        editing={Boolean(details)}
        mask={details?.kind === 'card' ? `•••• ${details.last4}` : undefined}
        disabled={disabled}
        controls={secretControls?.[kind === 'card' ? 'cardNumber' : 'password']}
        onChange={onSecretChange}
      />
      {kind === 'card' && (
        <>
          <Field label="Expiry date">
            <Input
              name="expiry"
              defaultValue={
                details?.kind === 'card'
                  ? formatCardExpiry(details.expiryMonth, details.expiryYear)
                  : ''
              }
              placeholder="MM / YYYY"
              inputMode="numeric"
              autoComplete="cc-exp"
              maxLength={9}
              required
              disabled={disabled}
            />
          </Field>
          <VaultSecretField
            name="securityCode"
            label="Security code"
            editing={Boolean(details)}
            saved={details?.kind === 'card' && details.hasSecurityCode}
            mask="••••"
            disabled={disabled}
            controls={secretControls?.securityCode}
            onChange={onSecretChange}
          />
        </>
      )}
    </>
  );
}

export function VaultItemForm({
  kind,
  onSaved,
}: {
  kind: 'login' | 'card';
  onSaved(entry: VaultListEntry): void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    form.current?.querySelector<HTMLInputElement>('input[name="label"]')?.focus();
    const clear = () => clearVaultSecret(form.current);
    const hidden = () => document.hidden && clear();
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      active.current = false;
      request.current?.abort();
      clear();
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !active.current) return;
    const values = new FormData(event.currentTarget);
    const expiry = kind === 'card' ? parseCardExpiry(values.get('expiry')) : null;
    if (kind === 'card' && !expiry) {
      setError('Enter an expiry date as MM / YYYY.');
      form.current?.querySelector<HTMLInputElement>('input[name="expiry"]')?.focus();
      return;
    }
    const label = String(values.get('label') ?? '');
    const username = String(values.get('username') ?? '');
    let body = JSON.stringify(
      kind === 'card'
        ? {
            kind,
            label,
            cardholder: String(values.get('cardholder') ?? ''),
            cardNumber: String(values.get('cardNumber') ?? ''),
            ...(values.get('securityCode')
              ? { securityCode: String(values.get('securityCode')) }
              : {}),
            ...expiry,
          }
        : {
            label,
            origin: String(values.get('origin') ?? ''),
            username,
            password: String(values.get('password') ?? ''),
          },
    );
    values.delete('password');
    values.delete('cardNumber');
    values.delete('securityCode');
    clearVaultSecret(form.current);
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      active.current && !controller.signal.aborted && request.current === controller;
    setSaving(true);
    setError('');
    try {
      const pending = api<VaultEntry>('/api/vault', {
        method: 'POST',
        body,
        cache: 'no-store',
        signal: controller.signal,
      });
      body = '';
      const entry = await pending;
      if (!current()) return;
      if (entry.kind !== kind) throw new Error('Unexpected item');
      form.current?.reset();
      onSaved(entry.kind === 'login' ? { ...entry, username } : entry);
    } catch {
      if (current())
        setError(
          kind === 'card'
            ? 'This card could not be saved. Check the details and try again.'
            : 'This login could not be saved. Check the website and try again.',
        );
    } finally {
      body = '';
      if (current()) {
        request.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <form
      ref={form}
      onSubmit={(event) => void submit(event)}
      className="form-stack vault-add-form"
      autoComplete="off"
    >
      <VaultFields kind={kind} disabled={saving} />
      {error && <Notice>{error}</Notice>}
      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : kind === 'card' ? 'Save card' : 'Save login'}
      </Button>
    </form>
  );
}
