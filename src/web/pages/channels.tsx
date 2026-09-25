import { PageTitle } from '../components/page-title';
import { ConnectionMenu } from '../components/connection-menu';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Settings2, Unplug } from 'lucide-react';
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
  Field,
  Input,
  Loading,
  Notice,
} from '../components/ui';

const providers = [
  {
    id: 'telegram' as const,
    name: 'Telegram',
    description: 'Ask questions and receive replies, images and files in Telegram.',
    note: 'Connect your own bot',
  },
  {
    id: 'whatsapp' as const,
    name: 'WhatsApp',
    description: 'Ask questions and receive replies on your WhatsApp Business number.',
    note: 'Requires a Meta business app',
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
}: {
  provider: ChannelProvider;
  step: number;
  fields: Record<string, string>;
  onField(name: string, value: string): void;
  policy: boolean;
  onPolicy(value: boolean): void;
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
            <p>
              Messages from Telegram user {fields.allowedUserId} will reach Sidekick while your Mac
              is running.
            </p>
          </div>
        </div>
        <p>
          After connecting, open your bot in Telegram, press Start, and send a short message. No
          public URL is needed.
        </p>
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
          <li>A public HTTPS callback for messages</li>
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
        Use these same callback settings in Meta, then subscribe the app to messages. Expose only
        this route; keep the rest of Sidekick private.
      </p>
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
      <Field
        label="Webhook verification token"
        hint="Choose 16–256 letters, digits, underscores or hyphens. Copy it into Meta before saving; it will not be shown again."
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
  setup,
  configured,
  onConfigure,
  onDisconnect,
  busy,
}: {
  setup?: ChannelSetup;
  configured: boolean;
  onConfigure(): void;
  onDisconnect(): void;
  busy: boolean;
}) {
  const botUrl = setup?.provider === 'telegram' ? telegramBotUrl(setup.accountHandle) : null;
  const [menuOpen, setMenuOpen] = useState(false);
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
      <div className="channel-account-actions">
        {needsDelivery ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setMenuOpen(true)}>
            Finish setup
            <ArrowRight size={13} />
          </Button>
        ) : botUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={botUrl} target="_blank" rel="noopener noreferrer">
              Open Telegram
              <ExternalLink size={13} />
            </a>
          </Button>
        ) : null}
        <ConnectionMenu
          label="Manage channel"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          disabled={busy}
          trigger={
            <>
              <Settings2 size={14} />
              Manage
            </>
          }
        >
          {(closeMenu) => (
            <>
              {needsDelivery && (
                <div className="channel-delivery-issue">
                  <p>
                    {setup?.webhookStatus === 'registration_pending'
                      ? 'Restart Sidekick to retry the saved setup, or replace it below.'
                      : 'Finish the callback in Meta and subscribe to messages.'}
                  </p>
                  {setup?.webhookUrl && <code>{setup.webhookUrl}</code>}
                  {setup?.webhookStatus !== 'registration_pending' && (
                    <p>
                      Use your saved verification token, or replace the setup if you need a new one.
                    </p>
                  )}
                </div>
              )}
              {configured && !setup && (
                <p>Local configuration is present. Send a message to check delivery.</p>
              )}
              <Button
                role="menuitem"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  closeMenu();
                  onConfigure();
                }}
              >
                Replace setup
              </Button>
              <Button
                role="menuitem"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  closeMenu();
                  onDisconnect();
                }}
              >
                <Unplug size={13} />
                Disconnect
              </Button>
            </>
          )}
        </ConnectionMenu>
      </div>
    </div>
  );
}

export function Channels() {
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
  const telegramStartLink = useRef<HTMLAnchorElement>(null);
  const request = useRef<AbortController | null>(null);
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
    if (!editing) return;
    if (step < steps[editing].length - 1) {
      setStep((value) => value + 1);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ channel: ChannelSetup }>(`/api/channel-settings/${editing}`, {
        method: 'PUT',
        body: JSON.stringify(channelSetupBody(editing, fields, policy)),
      });
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
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(provider: ChannelProvider) {
    if (
      !window.confirm(
        `Disconnect ${provider === 'telegram' ? 'Telegram' : 'WhatsApp'}? You will need its credentials to connect again.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ channel: ChannelSetup }>(`/api/channel-settings/${provider}`, {
        method: 'DELETE',
      });
      acceptedSetup(result.channel);
      void load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-page secondary-page channels-page">
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/channels" />
        </div>
      </header>
      {error && !editing && <Notice>{error}</Notice>}
      {data?.error && <Notice>{data.error}</Notice>}
      {settings && !settings.ready && (
        <Notice>The secure key store needs local setup before you can save a channel.</Notice>
      )}
      {!data || !settings ? (
        loading ? (
          <Loading label="Checking channels…" />
        ) : null
      ) : (
        <div className="channel-options">
          {[...providers]
            .sort((a, b) => {
              const connected = (id: ChannelProvider) =>
                Boolean(
                  settings.channels.some((item) => item.provider === id && item.enabled) ||
                  data.channels.some(
                    (item) => item.provider === id && item.status === 'configured',
                  ),
                );
              return Number(connected(a.id)) - Number(connected(b.id));
            })
            .map((provider) => {
              const setup = settings.channels.find((item) => item.provider === provider.id);
              const configured = data.channels.some(
                (item) => item.provider === provider.id && item.status === 'configured',
              );
              const connected = Boolean(setup?.enabled || configured);
              return (
                <section
                  className={`channel-option${connected ? ' is-connected' : ''}`}
                  key={provider.id}
                >
                  <div className="channel-option-heading">
                    <img src={`/logos/${provider.id}.svg`} alt="" width={28} height={28} />
                    <div>
                      <h2>{provider.name}</h2>
                      {!connected && <span>{provider.note}</span>}
                    </div>
                    {!connected && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Connect ${provider.name}`}
                        disabled={busy || !settings.ready}
                        onClick={() => open(provider.id)}
                      >
                        Connect
                        <ArrowRight size={13} />
                      </Button>
                    )}
                  </div>
                  {!connected && <p className="channel-option-benefit">{provider.description}</p>}
                  {connected && (
                    <ChannelAccount
                      setup={setup}
                      configured={configured}
                      onConfigure={() => open(provider.id)}
                      onDisconnect={() => void disconnect(provider.id)}
                      busy={busy || !settings.ready}
                    />
                  )}
                </section>
              );
            })}
        </div>
      )}
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
              ? 'Open your bot, press Start if prompted, then send your first request. Sidekick must be running to reply.'
              : step === 0
                ? 'Connect in a few small steps. Your current setup stays active until verification succeeds.'
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
                  Open Telegram
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
