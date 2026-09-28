import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import {
  channelLabel,
  channelSetupBody,
  telegramBotUrl,
  type ChannelProvider,
  type ChannelResponse,
  type ChannelSettings,
  type ChannelSetup,
} from '../lib/secondary-pages';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Loading,
  Notice,
} from '../components/ui';

const providers = [
  {
    id: 'telegram' as const,
    name: 'Telegram',
    description: 'Chat with Otto in Telegram.',
  },
  {
    id: 'whatsapp' as const,
    name: 'WhatsApp',
    description: 'Chat with Otto in WhatsApp.',
    comingSoon: true,
  },
];
const steps = {
  telegram: ['Create your bot', 'Keep it just for you', 'Ready to connect'],
  whatsapp: [
    'Before you begin',
    'Choose the numbers',
    'Verify your business app',
    'Set up message delivery',
  ],
};

function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="channel-external-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={12} />
    </a>
  );
}

export function ChannelSetupStep({
  provider,
  step,
  fields,
  onField,
  policy,
  onPolicy,
  hosted = false,
}: {
  provider: ChannelProvider;
  step: number;
  fields: Record<string, string>;
  onField(name: string, value: string): void;
  policy: boolean;
  onPolicy(value: boolean): void;
  hosted?: boolean;
}) {
  const field = (name: string) => ({
    value: fields[name] ?? '',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onField(name, event.target.value),
  });
  if (provider === 'telegram') {
    if (step === 0)
      return (
        <>
          <p>
            Open <ExternalLinkText href="https://t.me/BotFather">BotFather</ExternalLinkText> in
            Telegram and send <code>/newbot</code>. Choose a name and username, then paste the token
            it gives you.
          </p>
          <Field label="Bot token" hint="This stays outside chat and is encrypted when saved.">
            <Input type="password" autoComplete="off" required autoFocus {...field('botToken')} />
          </Field>
        </>
      );
    if (step === 1)
      return (
        <>
          <p>Only this Telegram account will be able to ask your bot to do things.</p>
          <Field
            label="Your Telegram user ID"
            hint="Your numeric account ID, not your phone number or @username."
          >
            <Input
              inputMode="numeric"
              pattern="[0-9]{1,16}"
              required
              autoFocus
              {...field('allowedUserId')}
            />
          </Field>
        </>
      );
    return (
      <>
        <div className="channel-setup-review">
          <Check size={18} />
          <div>
            <strong>One private conversation</strong>
            <p>Messages from Telegram user {fields.allowedUserId} will reach Otto.</p>
          </div>
        </div>
        <p>After connecting, open your bot in Telegram, press Start, and send a short message.</p>
        {!hosted && (
          <details className="channel-advanced">
            <summary>Advanced: use a webhook</summary>
            <Field label="Public HTTPS callback" hint="Leave blank to receive messages locally.">
              <Input
                type="url"
                pattern="https://.*"
                placeholder="https://your-domain.example/api/webhooks/telegram"
                {...field('webhookUrl')}
              />
            </Field>
          </details>
        )}
      </>
    );
  }
  if (step === 0)
    return (
      <>
        <p>
          Use a business bot number with Meta’s WhatsApp Cloud API. This does not connect your
          personal WhatsApp inbox.
        </p>
        <ul className="channel-requirements">
          <li>A Meta app with WhatsApp enabled</li>
          <li>A business sender number and its credentials</li>
          {!hosted && <li>A public HTTPS callback for messages</li>}
        </ul>
        <p>
          Replies are available for 24 hours after your message. Delayed proactive messages are not
          supported.
        </p>
        <label className="channel-policy">
          <input
            type="checkbox"
            checked={policy}
            required
            onChange={(event) => onPolicy(event.target.checked)}
          />
          <span>
            I have checked that my use is allowed under the{' '}
            <ExternalLinkText href="https://www.whatsapp.com/legal/business-solution-terms">
              current WhatsApp terms
            </ExternalLinkText>
            .
          </span>
        </label>
      </>
    );
  if (step === 1)
    return (
      <>
        <Field
          label="Business phone number ID"
          hint="Find the sender ID in Meta’s WhatsApp API setup. This is not the phone number itself."
        >
          <Input
            inputMode="numeric"
            pattern="[0-9]+"
            required
            autoFocus
            {...field('phoneNumberId')}
          />
        </Field>
        <Field
          label="Your WhatsApp number"
          hint="International digits without +. Only messages from this number are accepted."
        >
          <Input
            inputMode="tel"
            pattern="[0-9]{7,15}"
            placeholder="351910000000"
            required
            {...field('allowedNumber')}
          />
        </Field>
      </>
    );
  if (step === 2)
    return (
      <>
        <p>Copy these from your Meta app. They stay outside chat and are encrypted when saved.</p>
        <Field label="Business access token">
          <Input type="password" autoComplete="off" required autoFocus {...field('accessToken')} />
        </Field>
        <Field label="Meta app secret">
          <Input type="password" autoComplete="off" required {...field('appSecret')} />
        </Field>
      </>
    );
  return (
    <>
      <p>
        {hosted
          ? 'After connecting, copy the callback URL into Meta and subscribe to messages.'
          : 'Use these same callback settings in Meta, then subscribe the app to messages. Expose only this route; keep the rest of Otto private.'}
      </p>
      {!hosted && (
        <Field
          label="Public HTTPS callback"
          hint="You can leave this blank and finish delivery setup later."
        >
          <Input
            type="url"
            pattern="https://.*"
            placeholder="https://your-domain.example/api/webhooks/whatsapp"
            autoFocus
            {...field('webhookUrl')}
          />
        </Field>
      )}
      <Field
        label="Webhook verification token"
        hint="Choose 16–256 letters, digits, underscores or hyphens. Use the same token in Meta; it will not be shown again."
      >
        <Input
          type="password"
          autoComplete="off"
          minLength={16}
          maxLength={256}
          pattern="[A-Za-z0-9_-]{16,256}"
          required
          {...field('verifyToken')}
        />
      </Field>
    </>
  );
}

export function ChannelAccount({
  provider,
  setup,
  configured,
  onDisconnect,
  busy,
  hosted = false,
}: {
  provider: ChannelProvider;
  setup?: ChannelSetup;
  configured: boolean;
  onDisconnect(trigger: HTMLButtonElement): void;
  busy: boolean;
  hosted?: boolean;
}) {
  const botUrl = setup?.provider === 'telegram' ? telegramBotUrl(setup.accountHandle) : null;
  const name = setup?.accountName?.trim();
  const handle = setup?.accountHandle?.trim();
  const distinctHandle =
    handle &&
    name &&
    handle.replace(/^@/, '').toLowerCase() !== name.replace(/^@/, '').toLowerCase();
  const needsDelivery = Boolean(
    setup?.enabled && setup.mode === 'webhook' && setup.webhookStatus !== 'registered',
  );
  const statusLabel = channelLabel(setup, configured);
  return (
    <div className="channel-account">
      <div className="channel-account-row">
        <div className="channel-account-info">
          <div className="channel-account-label">
            <strong>{name || handle || 'Saved configuration'}</strong>
            {distinctHandle && <span>{handle}</span>}
          </div>
          {statusLabel && (
            <p className={`channel-account-status${needsDelivery ? ' needs-setup' : ''}`}>
              {statusLabel}
            </p>
          )}
        </div>
      </div>
      <div className="channel-account-actions">
        {needsDelivery ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>
                Finish setup
                <ArrowRight size={13} />
              </Button>
            </DialogTrigger>
            <DialogContent className="channel-delivery-dialog">
              <DialogTitle>
                Finish {provider === 'telegram' ? 'Telegram' : 'WhatsApp'} setup
              </DialogTitle>
              <DialogDescription>
                {setup?.webhookStatus === 'registration_pending'
                  ? hosted
                    ? 'Delivery setup could not finish. Contact the person who hosts Otto.'
                    : 'Restart Otto to retry the saved setup.'
                  : 'Finish the callback in Meta and subscribe to messages.'}
              </DialogDescription>
              {setup?.webhookUrl && (!hosted || provider === 'whatsapp') && (
                <div className="channel-delivery-address">
                  <span>Callback URL</span>
                  <code>{setup.webhookUrl}</code>
                </div>
              )}
              {setup?.webhookStatus !== 'registration_pending' && (
                <p>Use the verification token you saved when connecting this channel.</p>
              )}
            </DialogContent>
          </Dialog>
        ) : botUrl ? (
          <Button asChild size="sm">
            <a href={botUrl} target="_blank" rel="noopener noreferrer">
              Start conversation
              <ExternalLink size={13} />
            </a>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="channel-remove"
          data-channel-remove={provider}
          aria-label={`Remove ${provider === 'telegram' ? 'Telegram' : 'WhatsApp'} channel`}
          title="Remove channel"
          disabled={busy}
          onClick={(event) => onDisconnect(event.currentTarget)}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function Channels({ hosted = false }: { hosted?: boolean } = {}) {
  const [data, setData] = useState<ChannelResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ChannelProvider | null>(null);
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState(false);
  const [telegramStartUrl, setTelegramStartUrl] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ChannelProvider | null>(null);
  const [removeError, setRemoveError] = useState('');
  const telegramStartLink = useRef<HTMLAnchorElement>(null);
  const request = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const removeProvider = useRef<ChannelProvider | null>(null);
  const channels = providers.map((provider) => {
    const setup = settings?.channels.find((item) => item.provider === provider.id);
    const configured = Boolean(
      data?.channels.some((item) => item.provider === provider.id && item.status === 'configured'),
    );
    return { provider, setup, configured, connected: Boolean(setup?.enabled || configured) };
  });
  const connected = channels.filter((channel) => channel.connected);
  const available = channels.filter((channel) => !channel.connected);
  async function load() {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(true);
    try {
      const [status, setup] = await Promise.all([
        api<ChannelResponse>('/api/channels', { signal: current.signal }),
        api<ChannelSettings>('/api/channel-settings', { signal: current.signal }),
      ]);
      if (!current.signal.aborted) {
        setData(status);
        setSettings(setup);
        setError('');
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      request.current?.abort();
      actionRequest.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, []);
  useEffect(() => {
    if (telegramStartUrl) telegramStartLink.current?.focus();
  }, [telegramStartUrl]);
  function close() {
    setEditing(null);
    setFields({});
    setPolicy(false);
    setStep(0);
    setError('');
    setTelegramStartUrl(null);
  }
  function open(provider: ChannelProvider) {
    setFields({});
    setPolicy(false);
    setError('');
    setStep(0);
    setEditing(provider);
  }
  function acceptedSetup(channel: ChannelSetup) {
    request.current?.abort();
    setSettings((current) =>
      current
        ? {
            ...current,
            channels: [
              ...current.channels.filter((item) => item.provider !== channel.provider),
              channel,
            ],
          }
        : current,
    );
    setData((current) =>
      current
        ? {
            ...current,
            error: null,
            channels: [
              ...current.channels.filter((item) => item.provider !== channel.provider),
              {
                provider: channel.provider,
                status: channel.enabled ? 'configured' : 'disabled',
                missing: [],
              },
            ],
          }
        : current,
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || actionRequest.current || busy) return;
    if (step < steps[editing].length - 1) {
      setStep((value) => value + 1);
      return;
    }
    const current = new AbortController();
    actionRequest.current = current;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ channel: ChannelSetup }>(`/api/channel-settings/${editing}`, {
        method: 'PUT',
        body: JSON.stringify(channelSetupBody(editing, fields, policy)),
        signal: current.signal,
      });
      if (current.signal.aborted) return;
      acceptedSetup(result.channel);
      const botUrl =
        editing === 'telegram' && result.channel.provider === 'telegram' && result.channel.enabled
          ? telegramBotUrl(result.channel.accountHandle)
          : null;
      if (botUrl) {
        setFields({});
        setTelegramStartUrl(botUrl);
      } else close();
      void load();
    } catch (cause) {
      if (!current.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (actionRequest.current === current) actionRequest.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  async function disconnect() {
    const provider = removing;
    if (!provider || actionRequest.current || busy) return;
    const current = new AbortController();
    actionRequest.current = current;
    setBusy(true);
    setRemoveError('');
    try {
      const result = await api<{ channel: ChannelSetup }>(`/api/channel-settings/${provider}`, {
        method: 'DELETE',
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]),
      });
      if (current.signal.aborted) return;
      acceptedSetup(result.channel);
      setRemoving(null);
      void load();
    } catch (cause) {
      if (!current.signal.aborted) setRemoveError(errorMessage(cause));
    } finally {
      if (actionRequest.current === current) actionRequest.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  function cards(items: typeof channels) {
    return (
      <div className="channel-options">
        {items.map(({ provider, setup, configured, connected: isConnected }) => (
          <article
            className={`channel-option${isConnected ? ' is-connected' : ''}${
              !isConnected && 'comingSoon' in provider ? ' is-coming-soon' : ''
            }`}
            key={provider.id}
            aria-labelledby={`channel-${provider.id}`}
          >
            <div className="channel-option-heading">
              <img src={`/logos/${provider.id}.svg`} alt="" width={25} height={25} />
              <div>
                <h3 id={`channel-${provider.id}`}>{provider.name}</h3>
                <p className="channel-option-benefit">{provider.description}</p>
              </div>
              {!isConnected && 'comingSoon' in provider ? (
                <span className="channel-coming-soon">Coming soon</span>
              ) : (
                !isConnected && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="channel-connect"
                    aria-label={`Connect ${provider.name}`}
                    data-connect-channel={provider.id}
                    disabled={busy || !settings?.ready}
                    onClick={() => open(provider.id)}
                  >
                    Connect
                  </Button>
                )
              )}
            </div>
            {isConnected && (
              <ChannelAccount
                provider={provider.id}
                setup={setup}
                configured={configured}
                hosted={hosted}
                onDisconnect={(trigger) => {
                  removeTrigger.current = trigger;
                  removeProvider.current = provider.id;
                  setRemoveError('');
                  setRemoving(provider.id);
                }}
                busy={busy || !settings?.ready}
              />
            )}
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page channels-page" ref={page}>
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/channels" />
          <p>Chat with Otto in the apps you use.</p>
        </div>
      </header>
      {error && !editing && <Notice>{error}</Notice>}
      {data?.error && <Notice>{data.error}</Notice>}
      {settings && !settings.ready && (
        <Notice>
          {hosted
            ? 'Channel setup is temporarily unavailable.'
            : 'The secure key store needs local setup before you can save a channel.'}
        </Notice>
      )}
      {!data || !settings ? (
        loading ? (
          <Loading label="Checking channels…" />
        ) : null
      ) : (
        <>
          {connected.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-connected">
              <h2 id="channels-connected">Connected channels</h2>
              {cards(connected)}
            </section>
          )}
          {available.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-available">
              <h2 id="channels-available">
                {connected.length ? 'More channels' : 'Available channels'}
              </h2>
              {cards(available)}
            </section>
          )}
        </>
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!value && !busy) setRemoving(null);
        }}
      >
        <DialogContent
          className="channel-remove-dialog"
          aria-busy={busy}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-keep-channel]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = removeTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else
              (
                page.current?.querySelector<HTMLButtonElement>(
                  `[data-connect-channel="${removeProvider.current}"]`,
                ) ?? document.querySelector<HTMLElement>('#workspace')
              )?.focus();
          }}
        >
          <DialogTitle>
            Remove {removing === 'whatsapp' ? 'WhatsApp' : 'Telegram'} channel?
          </DialogTitle>
          <DialogDescription>
            Otto will stop receiving messages here. You will need its credentials to connect again.
          </DialogDescription>
          {removeError && <Notice>{removeError}</Notice>}
          <div className="channel-remove-actions">
            <Button
              data-keep-channel
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep channel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Removing…' : 'Remove channel'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(value) => {
          if (!value && !busy) close();
        }}
      >
        <DialogContent className="channel-wizard">
          <div className="channel-wizard-heading">
            <img src={`/logos/${editing ?? 'telegram'}.svg`} alt="" width={25} height={25} />
            <span>{editing === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>
            {!telegramStartUrl && (
              <small>
                Step {step + 1} of {steps[editing ?? 'telegram'].length}
              </small>
            )}
          </div>
          <DialogTitle>
            {telegramStartUrl ? 'Telegram is connected' : steps[editing ?? 'telegram'][step]}
          </DialogTitle>
          <DialogDescription className="channel-wizard-description">
            {telegramStartUrl
              ? hosted
                ? 'Open your bot, press Start if prompted, then send your first request.'
                : 'Open your bot, press Start if prompted, then send your first request. Otto must be running to reply.'
              : step === 0
                ? 'Connect in a few small steps. Otto checks your credentials before saving.'
                : 'Credentials stay in this secure form, outside the conversation.'}
          </DialogDescription>
          {error && <Notice>{error}</Notice>}
          {telegramStartUrl ? (
            <div className="channel-wizard-actions">
              <Button variant="ghost" size="sm" onClick={close}>
                Done
              </Button>
              <Button asChild>
                <a
                  ref={telegramStartLink}
                  href={telegramStartUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Start conversation
                  <ExternalLink size={14} />
                </a>
              </Button>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <div className="channel-wizard-step" key={`${editing}:${step}`}>
                <ChannelSetupStep
                  provider={editing ?? 'telegram'}
                  step={step}
                  fields={fields}
                  onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))}
                  policy={policy}
                  onPolicy={setPolicy}
                  hosted={hosted}
                />
              </div>
              <div className="channel-wizard-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => (step ? setStep((value) => value - 1) : close())}
                >
                  {step ? <ArrowLeft size={14} /> : null}
                  {step ? 'Back' : 'Cancel'}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy
                    ? 'Verifying…'
                    : step === steps[editing ?? 'telegram'].length - 1
                      ? editing === 'telegram'
                        ? 'Connect Telegram'
                        : 'Verify and save'
                      : 'Continue'}
                  {!busy && step < steps[editing ?? 'telegram'].length - 1 && (
                    <ArrowRight size={14} />
                  )}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
