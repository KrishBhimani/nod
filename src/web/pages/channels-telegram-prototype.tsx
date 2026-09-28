import { useState } from 'react';
import { Check, ExternalLink, FlaskConical } from 'lucide-react';
import { Button, DialogDescription, DialogTitle, Field, Input, Notice } from '../components/ui';

export type TelegramVariant = 'A' | 'B' | 'C';
const variants: Record<TelegramVariant, string> = {
  A: 'Two-step dialog',
  B: 'One-screen checklist',
  C: 'Inline on the card',
};
export const telegramVariant: TelegramVariant = (() => {
  if (!import.meta.env?.DEV || typeof location === 'undefined') return 'A';
  const value = new URLSearchParams(location.search).get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
})();

export interface TelegramFlow {
  hosted: boolean;
  busy: boolean;
  error: string;
  fields: Record<string, string>;
  onField(name: string, value: string): void;
  onVerify(event: React.FormEvent): void;
  onClose(): void;
  onNewLink(): void;
  pairingUrl: string | null;
  paired: boolean;
  expired: boolean;
  expiresAt?: string;
  pairedUser?: string;
  botHandle?: string;
  botUrl: string | null;
  linkRef: React.RefObject<HTMLAnchorElement | null>;
}

export function TelegramVariantSwitcher() {
  if (!import.meta.env?.DEV) return null;
  return (
    <nav className="telegram-prototype-switcher" aria-label="Telegram setup prototype">
      <span className="telegram-prototype-label">
        <FlaskConical size={13} aria-hidden="true" />
        Prototype
      </span>
      {(Object.keys(variants) as TelegramVariant[]).map((key) => (
        <a
          key={key}
          href={`?variant=${key}`}
          aria-current={key === telegramVariant ? 'page' : undefined}
          title={variants[key]}
        >
          {key}
          <span>{variants[key]}</span>
        </a>
      ))}
    </nav>
  );
}

function expiryTime(value?: string) {
  return value
    ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
}

export function TelegramPairingStatus({
  paired,
  expired,
  expiresAt,
  pairedUser,
}: Pick<TelegramFlow, 'paired' | 'expired' | 'expiresAt' | 'pairedUser'>) {
  return (
    <div
      className={`channel-pairing${paired ? ' is-paired' : expired ? ' is-expired' : ''}`}
      role="status"
    >
      {paired ? (
        <Check size={16} aria-hidden="true" />
      ) : (
        <span className="channel-pairing-signal" aria-hidden="true" />
      )}
      <div>
        <strong>
          {paired
            ? `Connected as ${pairedUser}`
            : expired
              ? 'This link has expired'
              : 'Waiting for Start'}
        </strong>
        <p>
          {paired
            ? 'Only this Telegram account can use your bot.'
            : expired
              ? 'Get a new link, then press Start again.'
              : `The link works once. It expires at ${expiryTime(expiresAt)}.`}
        </p>
      </div>
    </div>
  );
}

function TokenFields({ fields, onField, hosted }: TelegramFlow) {
  return (
    <>
      <Field label="Bot token" hint="This stays outside chat and is encrypted when saved.">
        <Input
          type="password"
          autoComplete="off"
          required
          autoFocus
          value={fields.botToken ?? ''}
          onChange={(event) => onField('botToken', event.target.value)}
        />
      </Field>
      {!hosted && (
        <details className="channel-advanced">
          <summary>Advanced: use a webhook</summary>
          <Field label="Public HTTPS callback" hint="Leave blank to receive messages locally.">
            <Input
              type="url"
              pattern="https://.*"
              placeholder="https://your-domain.example/api/webhooks/telegram"
              value={fields.webhookUrl ?? ''}
              onChange={(event) => onField('webhookUrl', event.target.value)}
            />
          </Field>
        </details>
      )}
    </>
  );
}

function BotFatherHint() {
  return (
    <p className="telegram-prototype-hint">
      Open{' '}
      <a
        className="channel-external-link"
        href="https://t.me/BotFather"
        target="_blank"
        rel="noopener noreferrer"
      >
        BotFather
        <ExternalLink size={12} />
      </a>{' '}
      in Telegram and send <code>/newbot</code>. Then paste the token it gives you.
    </p>
  );
}

function OpenTelegram({ flow }: { flow: TelegramFlow }) {
  const href = flow.paired ? (flow.botUrl ?? flow.pairingUrl!) : flow.pairingUrl!;
  return (
    <Button asChild size="sm">
      <a ref={flow.linkRef} href={href} target="_blank" rel="noopener noreferrer">
        {flow.paired ? 'Start conversation' : 'Open Telegram'}
        <ExternalLink size={13} />
      </a>
    </Button>
  );
}

export function TelegramChecklist(flow: TelegramFlow) {
  const { pairingUrl, paired, expired, busy } = flow;
  const [copied, setCopied] = useState(false);
  return (
    <>
      <DialogTitle>{paired ? 'Telegram is connected' : 'Connect Telegram'}</DialogTitle>
      <DialogDescription className="channel-wizard-description">
        {paired
          ? 'Send your bot a message to start.'
          : 'Two short steps. Otto checks the token before it saves anything.'}
      </DialogDescription>
      {flow.error && <Notice>{flow.error}</Notice>}
      <ol className="telegram-checklist">
        <li className={pairingUrl ? 'is-done' : 'is-active'}>
          <span className="telegram-checklist-marker" aria-hidden="true">
            {pairingUrl ? <Check size={13} /> : '1'}
          </span>
          <div>
            <strong>
              {pairingUrl ? `${flow.botHandle ?? 'Your bot'} is ready` : 'Add your bot'}
            </strong>
            {pairingUrl ? (
              <p>Otto checked the token with Telegram.</p>
            ) : (
              <form className="telegram-checklist-form" onSubmit={flow.onVerify}>
                <BotFatherHint />
                <TokenFields {...flow} />
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Checking…' : 'Check token'}
                </Button>
              </form>
            )}
          </div>
        </li>
        <li className={paired ? 'is-done' : pairingUrl ? 'is-active' : 'is-next'}>
          <span className="telegram-checklist-marker" aria-hidden="true">
            {paired ? (
              <Check size={13} />
            ) : pairingUrl && !expired ? (
              <span className="channel-pairing-signal" />
            ) : (
              '2'
            )}
          </span>
          <div>
            <strong>
              {paired ? `Connected as ${flow.pairedUser}` : 'Press Start in Telegram'}
            </strong>
            <p>
              {paired
                ? 'Only this Telegram account can use your bot.'
                : !pairingUrl
                  ? 'After the check, Otto gives you a one-time link.'
                  : expired
                    ? 'This link has expired. Get a new link, then press Start again.'
                    : `Open your bot and press Start. Otto connects the first account that uses the link. It expires at ${expiryTime(flow.expiresAt)}.`}
            </p>
            {pairingUrl && !paired && (
              <div className="telegram-checklist-actions">
                {expired ? (
                  <Button size="sm" disabled={busy} onClick={flow.onNewLink}>
                    {busy ? 'Creating link…' : 'Get a new link'}
                  </Button>
                ) : (
                  <>
                    <OpenTelegram flow={flow} />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(pairingUrl)
                          .then(() => setCopied(true))
                          .catch(() => {})
                      }
                    >
                      {copied ? 'Link copied' : 'Copy link for your phone'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </li>
      </ol>
      <div className="channel-wizard-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={flow.onClose}>
          {paired ? 'Done' : pairingUrl ? 'Close' : 'Cancel'}
        </Button>
        {paired && <OpenTelegram flow={flow} />}
      </div>
    </>
  );
}

export function TelegramInline(flow: TelegramFlow) {
  const { pairingUrl, paired, expired, busy } = flow;
  if (!pairingUrl)
    return (
      <form className="telegram-inline" onSubmit={flow.onVerify}>
        <BotFatherHint />
        {flow.error && <Notice>{flow.error}</Notice>}
        <TokenFields {...flow} />
        <div className="telegram-inline-actions">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={flow.onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Checking…' : 'Check token'}
          </Button>
        </div>
      </form>
    );
  return (
    <div className="telegram-inline">
      {flow.error && <Notice>{flow.error}</Notice>}
      {!paired && (
        <p className="telegram-prototype-hint">
          {flow.botHandle ?? 'Your bot'} is ready. Open it and press Start. Otto connects the first
          Telegram account that uses this link.
        </p>
      )}
      <TelegramPairingStatus {...flow} />
      <div className="telegram-inline-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={flow.onClose}>
          {paired ? 'Done' : 'Close'}
        </Button>
        {expired ? (
          <Button size="sm" disabled={busy} onClick={flow.onNewLink}>
            {busy ? 'Creating link…' : 'Get a new link'}
          </Button>
        ) : (
          <OpenTelegram flow={flow} />
        )}
      </div>
    </div>
  );
}
