import { useEffect, useState } from 'react';
import { ExternalLink, Plus, RefreshCw, Unplug } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
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

type Provider = 'telegram' | 'whatsapp';
type ChannelStatus = {
  provider: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
};
type ChannelResponse = { channels: ChannelStatus[]; error: string | null };
type SetupSummary = {
  provider: Provider;
  enabled: boolean;
  accountName?: string;
  accountHandle?: string;
  mode?: 'polling' | 'webhook';
  webhookStatus?: 'registered' | 'manual_setup';
  webhookUrl?: string;
};
type SettingsResponse = { ready: boolean; channels: SetupSummary[] };
const providers: Array<{ id: Provider; name: string; description: string }> = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to Sidekick through your own Telegram bot.',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Message Sidekick using a WhatsApp Business number.',
  },
];

export function Channels() {
  const [data, setData] = useState<ChannelResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState(false);
  async function load() {
    try {
      const [status, setup] = await Promise.all([
        api<ChannelResponse>('/api/channels'),
        api<SettingsResponse>('/api/channel-settings'),
      ]);
      setData(status);
      setSettings(setup);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function open(provider: Provider) {
    setFields({});
    setPolicy(false);
    setError('');
    setEditing(provider);
  }
  function field(name: string) {
    return {
      value: fields[name] ?? '',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setFields({ ...fields, [name]: event.target.value }),
    };
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const body =
        editing === 'telegram'
          ? {
              botToken: fields.botToken,
              allowedUserId: fields.allowedUserId,
              webhookUrl: fields.webhookUrl?.trim() || undefined,
            }
          : {
              accessToken: fields.accessToken,
              appSecret: fields.appSecret,
              phoneNumberId: fields.phoneNumberId,
              allowedNumber: fields.allowedNumber,
              verifyToken: fields.verifyToken,
              webhookUrl: fields.webhookUrl?.trim() || undefined,
              policyConfirmed: policy,
            };
      await api(`/api/channel-settings/${editing}`, { method: 'PUT', body: JSON.stringify(body) });
      setFields({});
      setEditing(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(provider: Provider) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/channel-settings/${provider}`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-page">
      <header className="page-heading">
        <div>
          <h1>Channels</h1>
          <p>Keep the conversation going where you already chat.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void load()}
          aria-label="Refresh channels"
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      {error && !editing && <Notice>{error}</Notice>}
      {data?.error && <Notice>{data.error}</Notice>}
      {settings && !settings.ready && (
        <Notice>The secure key store needs to be set up before saving channel credentials.</Notice>
      )}
      {!data || !settings ? (
        <Loading label="Checking channels…" />
      ) : (
        <div className="service-list">
          {providers.map((provider) => {
            const state = data.channels.find((item) => item.provider === provider.id);
            const setup = settings.channels.find((item) => item.provider === provider.id);
            const configured = state?.status === 'configured';
            const label = setup?.enabled
              ? setup.mode === 'polling'
                ? 'Local polling enabled'
                : setup.webhookStatus === 'registered'
                  ? 'Webhook registered'
                  : 'Finish webhook setup'
              : configured
                ? 'Configuration present'
                : 'Not connected';
            return (
              <section className="service-row" key={provider.id}>
                <div className="connection-main">
                  <img
                    className="service-logo"
                    src={`/logos/${provider.id}.svg`}
                    alt=""
                    width={32}
                    height={32}
                  />
                  <div className="connection-description">
                    <h2>{provider.name}</h2>
                    <p>{provider.description}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !settings.ready}
                    onClick={() => open(provider.id)}
                  >
                    <Plus size={14} />
                    {configured ? 'Update setup' : 'Connect'}
                  </Button>
                </div>
                <div className="account-row">
                  <div className="connection-main">
                    <div className="connection-description">
                      {setup?.accountName && <h3>{setup.accountName}</h3>}
                      {setup?.accountHandle && <p>{setup.accountHandle}</p>}
                      <span className="channel-status">{label}</span>
                    </div>
                    {(setup?.enabled || configured) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void disconnect(provider.id)}
                      >
                        <Unplug size={14} />
                        Disconnect
                      </Button>
                    )}
                  </div>
                  {setup?.enabled && setup.mode === 'polling' && (
                    <p className="field-hint">
                      Open your bot, press Start, and send a message. Sidekick checks for messages
                      while this Mac is running. No public URL is needed.
                    </p>
                  )}
                  {provider.id === 'telegram' &&
                    setup?.accountHandle &&
                    /^@[A-Za-z0-9_]+$/.test(setup.accountHandle) && (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={`https://t.me/${setup.accountHandle.slice(1)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open bot
                          <ExternalLink size={13} />
                        </a>
                      </Button>
                    )}
                  {setup?.enabled && setup.mode === 'webhook' && (
                    <div className="channel-details">
                      <p>
                        {setup.webhookStatus === 'registered'
                          ? 'The webhook is registered. Send a short message to check the full conversation.'
                          : 'In Meta, register the public HTTPS callback and verification token you entered, then subscribe to messages.'}
                      </p>
                      {setup.webhookUrl && <code>{setup.webhookUrl}</code>}
                      <p className="field-hint">
                        Expose only the webhook route. Keep the rest of Sidekick private.
                      </p>
                    </div>
                  )}
                  {configured && !setup && (
                    <p className="field-hint">
                      Local configuration is present. A successful message and reply still need to
                      be checked.
                    </p>
                  )}
                  {!setup?.enabled && !configured && (
                    <p className="field-hint">
                      {provider.id === 'telegram' ? (
                        <>
                          Create a bot with{' '}
                          <a
                            href="https://t.me/BotFather"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            BotFather
                          </a>
                          , then enter its token here.
                        </>
                      ) : (
                        'Requires WhatsApp Business Cloud credentials and a business sender number.'
                      )}
                    </p>
                  )}
                  <p className="field-hint">
                    {provider.id === 'telegram'
                      ? 'Only your configured private chat can start tasks.'
                      : 'This connects a business bot number, not your personal WhatsApp inbox. Replies require your message within the last 24 hours.'}
                  </p>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <p className="field-hint">
        Voice, files, credentials, and approvals stay in the web app. Your Mac and Sidekick must
        stay running to reply.
      </p>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(null);
            setFields({});
            setPolicy(false);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {editing === 'telegram' ? 'Connect Telegram' : 'Connect WhatsApp'}
          </DialogTitle>
          <DialogDescription>
            Credentials are verified, encrypted locally, and never sent to the assistant. Existing
            local settings stay active if account verification fails.
          </DialogDescription>
          {error && <Notice>{error}</Notice>}
          <form className="form-stack" onSubmit={(event) => void save(event)}>
            {editing === 'telegram' ? (
              <>
                <Field
                  label="Bot token"
                  hint="Create a bot with BotFather. Keep its token private."
                >
                  <Input type="password" autoComplete="off" required {...field('botToken')} />
                </Field>
                <Field
                  label="Your Telegram user ID"
                  hint="Use your numeric ID, not your @username. Only this private chat will be accepted."
                >
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]{1,16}"
                    required
                    {...field('allowedUserId')}
                  />
                </Field>
                <details>
                  <summary>Use a public webhook instead</summary>
                  <Field
                    label="Public webhook URL"
                    hint="Optional. Leave blank to receive messages locally without a tunnel."
                  >
                    <Input
                      type="url"
                      placeholder="https://your-domain.example/api/webhooks/telegram"
                      {...field('webhookUrl')}
                    />
                  </Field>
                </details>
              </>
            ) : (
              <>
                <Field label="Business access token">
                  <Input type="password" autoComplete="off" required {...field('accessToken')} />
                </Field>
                <Field label="Meta app secret">
                  <Input type="password" autoComplete="off" required {...field('appSecret')} />
                </Field>
                <Field
                  label="Business phone number ID"
                  hint="The sender ID in Meta, not the phone number itself."
                >
                  <Input inputMode="numeric" required {...field('phoneNumberId')} />
                </Field>
                <Field
                  label="Your WhatsApp number"
                  hint="International digits, without +. Only messages from this number are accepted."
                >
                  <Input
                    inputMode="tel"
                    placeholder="351910000000"
                    required
                    {...field('allowedNumber')}
                  />
                </Field>
                <Field
                  label="Webhook verification token"
                  hint="Choose 16–256 letters, digits, underscores or hyphens. Use the same value in Meta; it will not be shown again."
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    minLength={16}
                    maxLength={256}
                    required
                    {...field('verifyToken')}
                  />
                </Field>
                <Field
                  label="Public webhook URL"
                  hint="You can add this later. Message delivery requires a public HTTPS callback."
                >
                  <Input
                    type="url"
                    placeholder="https://your-domain.example/api/webhooks/whatsapp"
                    {...field('webhookUrl')}
                  />
                </Field>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={policy}
                    required
                    onChange={(event) => setPolicy(event.target.checked)}
                  />
                  I have checked that my intended use is allowed under the{' '}
                  <a
                    href="https://www.whatsapp.com/legal/business-solution-terms"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    current WhatsApp terms
                  </a>
                  .
                </label>
              </>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setFields({});
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify and connect'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
