import { useEffect, useState } from 'react';
import { Globe2, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { VaultEntry } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { relativeTime } from '../lib/utils';
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

export function originLabel(origin: string) {
  try {
    return new URL(origin).hostname;
  } catch {
    return 'Website';
  }
}

function VaultForm({ onSaved }: { onSaved(): void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    setError('');
    try {
      await post<VaultEntry>('/api/vault', {
        label: data.get('label'),
        origin: data.get('origin'),
        username: data.get('username'),
        password: data.get('password'),
      });
      form.reset();
      onSaved();
    } catch {
      setError('This login could not be saved. Check the website and try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="form-stack" autoComplete="off">
      <Field label="Name">
        <Input name="label" placeholder="For example, my work account" required maxLength={120} />
      </Field>
      <Field label="Website" hint="This login will only be used on this website.">
        <Input name="origin" type="url" placeholder="https://example.com" required />
      </Field>
      <Field label="Username or email">
        <Input name="username" autoComplete="username" required />
      </Field>
      <Field label="Password">
        <Input name="password" type="password" autoComplete="new-password" required />
      </Field>
      {error && <Notice>{error}</Notice>}
      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save login'}
      </Button>
    </form>
  );
}

export function Vault() {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<VaultEntry | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      setEntries(await api<VaultEntry[]>('/api/vault'));
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/vault/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      setDeleting(null);
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
          <h1>Your vault</h1>
          <p>Logins, kept out of the conversation.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus size={16} />
          Add login
        </Button>
      </header>
      <div className="privacy-note">
        <ShieldCheck size={18} />
        <p>
          Sidekick can fill a login when a task needs it. Passwords stay in the trusted login
          service.
        </p>
      </div>
      {error && <Notice>{error}</Notice>}
      {!entries ? (
        !error && <Loading label="Opening your vault…" />
      ) : entries.length ? (
        <div className="resource-list">
          {entries.map((entry) => (
            <div className="resource-row" key={entry.id}>
              <span className="resource-icon">
                <Globe2 size={20} />
              </span>
              <div className="resource-description">
                <h2>{entry.label}</h2>
                <p>
                  {originLabel(entry.origin)}
                  {entry.usernameHint && (
                    <>
                      <span className="text-separator">/</span>
                      {entry.usernameHint}
                    </>
                  )}
                </p>
              </div>
              <span className="resource-date">{relativeTime(entry.updatedAt)}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${entry.label}`}
                onClick={() => setDeleting(entry)}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <KeyRound size={31} strokeWidth={1.4} />
          <h2>A safe place for your logins.</h2>
          <p>
            Add a login here, or enter one securely
            <br />
            when a task needs it.
          </p>
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus size={15} />
            Add your first login
          </Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <div className="dialog-heading">
            <KeyRound size={22} />
            <DialogTitle>Add a login</DialogTitle>
            <DialogDescription>
              Stored securely and used only for the matching website.
            </DialogDescription>
          </div>
          <VaultForm
            onSaved={() => {
              setOpen(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(value) => {
          if (!value && !busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <div className="dialog-heading">
            <DialogTitle>Delete this login?</DialogTitle>
            <DialogDescription>
              {deleting?.label} will be removed from your vault. You can add it again later.
            </DialogDescription>
          </div>
          <div className="dialog-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
              Keep login
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete login'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
