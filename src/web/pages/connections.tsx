import { useEffect, useState } from 'react';
import {
  Bell,
  CalendarDays,
  Check,
  ExternalLink,
  FileText,
  FolderOpen,
  Link2,
  Mail,
  Table2,
  Unplug,
} from 'lucide-react';
import type { Connection, Preferences } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { Button, Field, Input, Loading, Notice, Textarea } from '../components/ui';

const connectionDetails: Record<string, { icon: typeof Mail; description: string }> = {
  gmail: { icon: Mail, description: 'Find email and stay on top of replies.' },
  googlecalendar: { icon: CalendarDays, description: 'Plan your time and follow meeting changes.' },
  googledrive: { icon: FolderOpen, description: 'Find files and keep documents within reach.' },
  googlesheets: { icon: Table2, description: 'Read and update your spreadsheets.' },
  googledocs: { icon: FileText, description: 'Work with your notes and documents.' },
};

export function Connections() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState(false);
  const [connectUrl, setConnectUrl] = useState('');
  async function load() {
    try {
      setConnections(await api<Connection[]>('/api/connections'));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    void load();
    void api<Preferences>('/api/preferences')
      .then(setPreferences)
      .catch((cause) => setError(errorMessage(cause)));
    const focus = () => {
      void load();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  async function connect(connection: Connection) {
    setBusy(connection.slug);
    setError('');
    setConnectUrl('');
    try {
      const result = await post<{ url: string }>(
        `/api/connections/${encodeURIComponent(connection.slug)}/connect`,
      );
      const url = new URL(result.url);
      if (url.protocol !== 'https:') throw new Error('The sign-in address could not be verified.');
      setConnectUrl(url.href);
      window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function disconnect(connection: Connection) {
    setBusy(connection.slug);
    setError('');
    try {
      await post(`/api/connections/${encodeURIComponent(connection.slug)}/disconnect`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function toggle(connection: Connection) {
    setBusy(connection.slug);
    setError('');
    try {
      await post(`/api/connections/${encodeURIComponent(connection.slug)}/triggers`, {
        enabled: !connection.triggersEnabled,
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    setBusy('preferences');
    setSaved(false);
    setError('');
    try {
      await api('/api/preferences', { method: 'PUT', body: JSON.stringify(preferences) });
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="content-page">
      <header className="page-heading">
        <div>
          <h1>A little more connected.</h1>
          <p>Bring your email, calendar, and files into the conversation.</p>
        </div>
        <span className="heading-icon">
          <Link2 size={23} />
        </span>
      </header>
      {error && <Notice>{error}</Notice>}
      {connectUrl && (
        <Notice kind="info">
          Finish connecting in the sign-in window.{' '}
          <a href={connectUrl} target="_blank" rel="noopener noreferrer">
            Open sign-in <ExternalLink size={12} />
          </a>
        </Notice>
      )}
      {!connections ? (
        !error && <Loading label="Checking connections…" />
      ) : (
        <div className="connections-list">
          {connections.map((connection) => {
            const details = connectionDetails[connection.slug] ?? {
              icon: Link2,
              description: 'Bring this account into your conversation.',
            };
            return (
              <section key={connection.slug} className="connection-row">
                <div className="connection-main">
                  <div className={`connection-icon ${connection.slug}`}>
                    <details.icon size={24} />
                  </div>
                  <div className="connection-description">
                    <h2>{connection.name}</h2>
                    <p>
                      {connection.status === 'connected'
                        ? 'Connected to your account'
                        : (connection.description ?? details.description)}
                    </p>
                  </div>
                  {connection.status === 'connected' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy)}
                      onClick={() => void disconnect(connection)}
                    >
                      <Unplug size={14} />
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={connection.status === 'not_configured' || Boolean(busy)}
                      onClick={() => void connect(connection)}
                    >
                      {busy === connection.slug ? 'Connecting…' : 'Connect'}
                    </Button>
                  )}
                </div>
                {connection.status === 'not_configured' && (
                  <p className="connection-setup">
                    Finish local connection setup to link your account.
                  </p>
                )}
                {connection.status === 'connected' && connection.supportsTriggers && (
                  <div className="connection-trigger">
                    <div>
                      <span>Watch for changes</span>
                      <small>Use your preferences below to decide what needs attention.</small>
                    </div>
                    <button
                      className={`toggle ${connection.triggersEnabled ? 'toggle-on' : ''}`}
                      role="switch"
                      aria-checked={connection.triggersEnabled}
                      aria-label={`Watch for ${connection.name} changes`}
                      disabled={Boolean(busy)}
                      onClick={() => void toggle(connection)}
                    >
                      <span />
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <section className="preferences-section">
        <div className="section-heading">
          <Bell size={19} />
          <div>
            <h2>When to interrupt me</h2>
            <p>Only events matching your preferences can start a task.</p>
          </div>
        </div>
        {preferences ? (
          <form onSubmit={(event) => void savePreferences(event)} className="form-stack">
            <Textarea
              aria-label="Notification preferences"
              rows={4}
              value={preferences.notificationRule}
              onChange={(event) => {
                setSaved(false);
                setPreferences({ ...preferences, notificationRule: event.target.value });
              }}
              placeholder="For example, tell me about meeting changes today and emails that need a reply from me."
            />
            <p className="field-hint">Leave this empty to save updates quietly.</p>
            <div className="quiet-hours">
              <Field label="Quiet hours start">
                <Input
                  type="time"
                  required
                  value={preferences.quietStart}
                  onChange={(event) => {
                    setSaved(false);
                    setPreferences({ ...preferences, quietStart: event.target.value });
                  }}
                />
              </Field>
              <Field label="Quiet hours end">
                <Input
                  type="time"
                  required
                  value={preferences.quietEnd}
                  onChange={(event) => {
                    setSaved(false);
                    setPreferences({ ...preferences, quietEnd: event.target.value });
                  }}
                />
              </Field>
              <Field label="Time zone">
                <Input
                  required
                  value={preferences.timeZone}
                  onChange={(event) => {
                    setSaved(false);
                    setPreferences({ ...preferences, timeZone: event.target.value });
                  }}
                  placeholder="Europe/Lisbon"
                />
              </Field>
            </div>
            <div className="preferences-actions">
              <Button variant="secondary" type="submit" disabled={busy === 'preferences'}>
                {busy === 'preferences' ? 'Saving…' : 'Save preferences'}
              </Button>
              {saved && (
                <span className="saved-state" role="status">
                  <Check size={15} />
                  Saved
                </span>
              )}
            </div>
          </form>
        ) : (
          <Loading label="Loading your preferences…" />
        )}
      </section>
    </div>
  );
}
