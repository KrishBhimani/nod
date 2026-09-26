import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  FlaskConical,
  Goal,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  PanelLeftClose,
  Pause,
  PlugZap,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { BrandMark } from '../../components/brand';
import '../../theme.css';
import './prototype.css';

type Variant = 'A' | 'B' | 'C';
type Page =
  | 'Chat'
  | 'Goals'
  | 'Schedule'
  | 'Apps'
  | 'Channels'
  | 'Vault'
  | 'Computer'
  | 'Profile'
  | 'Settings';
type AccountId = 'alex' | 'sam';
type AppId = 'gmail' | 'googlecalendar' | 'googledrive' | 'slack' | 'notion';
type Connection = {
  id: string;
  identity: string;
  status: 'pending' | 'ready' | 'attention';
  lastEvent: string | null;
};
type Theme = 'system' | 'light' | 'dark';
type Person = {
  name: string;
  email: string;
  theme: Theme;
  timezone: string;
  quiet: boolean;
  apps: Partial<Record<AppId, Connection[]>>;
  telegram: 'none' | 'paired' | 'tested';
  hostMode: string;
  computer: 'asleep' | 'running' | 'manual' | 'unavailable';
  messages: { role: 'user' | 'assistant'; text: string }[];
};

const variants: Record<Variant, { title: string; detail: string }> = {
  A: {
    title: 'Quick start',
    detail:
      'Optional app setup, then chat. Profile and settings open from your account in the sidebar.',
  },
  B: {
    title: 'Guided setup',
    detail:
      'Connect apps and set preferences before entering. Account settings have a dedicated page.',
  },
  C: {
    title: 'Chat first',
    detail: 'Go straight into a conversation. Setup and account settings open alongside it.',
  },
};
const apps: { id: AppId; name: string; description: string; access: string[] }[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Find emails and stay on top of replies.',
    access: [
      'Read and search email',
      'Draft and send replies when you ask',
      'Notice new messages in the background',
    ],
  },
  {
    id: 'googlecalendar',
    name: 'Google Calendar',
    description: 'Make time for what is coming up.',
    access: [
      'Read your calendars and events',
      'Create or change events when you ask',
      'Notice changes in the background',
    ],
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    description: 'Bring your files into the conversation.',
    access: ['Find and read files you grant access to', 'Create and edit files when you ask'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Catch up on the conversations that matter.',
    access: ['Read permitted channels', 'Send messages when you ask'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Work with the pages you choose to share.',
    access: ['Read the pages you select', 'Update those pages when you ask'],
  },
];
const nav = [
  { name: 'Chat', icon: MessageCircle },
  { name: 'Goals', icon: Goal },
  { name: 'Schedule', icon: Clock3 },
  { name: 'Apps', icon: PlugZap },
  { name: 'Channels', icon: Send },
  { name: 'Vault', icon: KeyRound },
] as const;
const freshPeople = (): Record<AccountId, Person> => ({
  alex: {
    name: 'Alex Morgan',
    email: 'alex@example.test',
    theme: 'system',
    timezone: 'Europe/Lisbon',
    quiet: true,
    apps: {},
    telegram: 'none',
    hostMode: 'Managed cloud computer',
    computer: 'asleep',
    messages: [],
  },
  sam: {
    name: 'Sam Rivera',
    email: 'sam@example.test',
    theme: 'system',
    timezone: 'Europe/London',
    quiet: true,
    apps: {},
    telegram: 'none',
    hostMode: 'Managed cloud computer',
    computer: 'asleep',
    messages: [],
  },
});

function GoogleMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.8-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.93a6 6 0 0 1 0-3.86V7.48H3.06a10 10 0 0 0 0 9.04l3.34-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.88-2.87A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.94 5.48l3.34 2.59A6 6 0 0 1 12 5.95Z"
      />
    </svg>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  className = '',
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`btn ${primary ? 'primary' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Logo({ word = true }: { word?: boolean }) {
  return (
    <div className="logo">
      <BrandMark />
      {word && <span>sidekick</span>}
    </div>
  );
}
function AppIcon({ id }: { id: AppId | 'telegram' }) {
  return (
    <span className="app-icon">
      <img src={`/logos/${id}.svg`} alt="" />
    </span>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function App() {
  const initial = new URLSearchParams(location.search).get('variant');
  const [variant, setVariant] = useState<Variant>(
    initial === 'B' || initial === 'C' ? initial : 'A',
  );
  const [people, setPeople] = useState(freshPeople);
  const [account, setAccount] = useState<AccountId | null>(null);
  const [screen, setScreen] = useState<'login' | 'welcome' | 'preferences' | 'app'>('login');
  const [page, setPage] = useState<Page>('Chat');
  const [settingsTab, setSettingsTab] = useState<
    'Profile' | 'Appearance' | 'Preferences' | 'Privacy'
  >('Profile');
  const [accountMenu, setAccountMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [review, setReview] = useState(false);
  const [modal, setModal] = useState<'google' | 'telegram' | 'disconnect' | null>(null);
  const [connecting, setConnecting] = useState<AppId | null>(null);
  const [disconnecting, setDisconnecting] = useState<{ app: AppId; connection: Connection } | null>(
    null,
  );
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [telegramStep, setTelegramStep] = useState<
    'token' | 'waiting' | 'confirm' | 'test' | 'expired' | 'conflict'
  >('token');
  const [toast, setToast] = useState('');
  const [authError, setAuthError] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingName, setEditingName] = useState('');
  const connectionSequence = useRef(0);
  const person = people[account ?? 'alex'];
  const connectedAccounts = Object.values(person.apps).flat();
  const connectedCount = connectedAccounts.length;
  const availableCount = connectedAccounts.filter(
    (connection) => connection.status !== 'attention',
  ).length;
  const telegramIdentity = account === 'sam' ? 'Sam Rivera' : 'Alex Morgan';
  const telegramHandle = `@${account ?? 'alex'}_sidekick_demo_bot`;
  const startConnection = (id: AppId, connectionId: string | null = null) => {
    setConnecting(id);
    setReconnecting(connectionId);
    setConnectionError('');
  };
  const patch = (change: Partial<Person>) => {
    if (account)
      setPeople((current) => ({ ...current, [account]: { ...current[account], ...change } }));
  };
  const notice = (text: string) => setToast(text);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4300);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        person.theme === 'system' ? (media.matches ? 'dark' : 'light') : person.theme;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [person.theme]);
  const chooseVariant = (next: Variant) => {
    setVariant(next);
    setSettingsOpen(false);
    setAccountMenu(false);
    const url = new URL(location.href);
    url.searchParams.set('variant', next);
    history.replaceState({}, '', url);
  };
  const cycle = (direction: number) =>
    chooseVariant(
      (['A', 'B', 'C'] as Variant[])[(['A', 'B', 'C'].indexOf(variant) + direction + 3) % 3],
    );
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable],dialog') ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
      if (e.key === 'Escape') {
        setAccountMenu(false);
        setSettingsOpen(false);
        setReview(false);
        setMobileNav(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [variant]);
  const enter = (id: AccountId) => {
    setAccount(id);
    setEditingName(people[id].name);
    setModal(null);
    setAuthError('');
    setAccessDenied(false);
    setScreen(people[id].messages.length || variant === 'C' ? 'app' : 'welcome');
    setPage('Chat');
    setAccountMenu(false);
    setDraft('');
    setConnecting(null);
    setDisconnecting(null);
    setReconnecting(null);
    setConnectionError('');
    setTelegramStep('token');
    setToast('');
    setSettingsOpen(false);
    setMobileNav(false);
    setReview(false);
    setSettingsTab('Profile');
  };
  const go = (next: Page) => {
    setPage(next);
    setMobileNav(false);
    setAccountMenu(false);
    setAccessDenied(false);
  };
  const openSettings = (tab: typeof settingsTab) => {
    setSettingsTab(tab);
    setEditingName(person.name);
    setAccountMenu(false);
    if (variant === 'B') go(tab === 'Profile' ? 'Profile' : 'Settings');
    else setSettingsOpen(true);
  };
  const signOut = () => {
    setAccount(null);
    setAuthError('');
    setScreen('login');
    setSettingsOpen(false);
    setAccountMenu(false);
    setDraft('');
    setConnecting(null);
    setDisconnecting(null);
    setReconnecting(null);
    setConnectionError('');
    setModal(null);
    setTelegramStep('token');
    setToast('');
    setMobileNav(false);
    setAccessDenied(false);
  };
  const nextIdentity = (id: AppId) => {
    const used = new Set((person.apps[id] ?? []).map((connection) => connection.identity));
    if (!used.has(person.email)) return person.email;
    let index = 1;
    while (used.has(`${account}.work${index > 1 ? index : ''}@example.test`)) index++;
    return `${account}.work${index > 1 ? index : ''}@example.test`;
  };
  const connect = (id: AppId) => {
    const existing = person.apps[id] ?? [];
    const status = id === 'gmail' || id === 'googlecalendar' ? 'pending' : 'ready';
    const next: Connection[] = reconnecting
      ? existing.map((connection) =>
          connection.id === reconnecting ? { ...connection, status, lastEvent: null } : connection,
        )
      : [
          ...existing,
          {
            id: `demo-connection-${++connectionSequence.current}`,
            identity: nextIdentity(id),
            status,
            lastEvent: null,
          },
        ];
    patch({ apps: { ...person.apps, [id]: next } });
    setConnecting(null);
    setReconnecting(null);
    setConnectionError('');
    notice(
      `${apps.find((a) => a.id === id)?.name} ${reconnecting ? 'reconnected' : 'connected'} in this preview.`,
    );
  };
  const advanceAppSetup = () => {
    const next = { ...person.apps };
    let changed = false;
    for (const id of ['gmail', 'googlecalendar'] as const)
      next[id] = (next[id] ?? []).map((connection) => {
        if (connection.status !== 'pending') return connection;
        changed = true;
        return { ...connection, status: 'ready' };
      });
    patch({ apps: next });
    setScreen('app');
    go('Apps');
    notice(
      changed
        ? 'Periodic updates enabled in this preview. No event has arrived yet.'
        : 'Connect Gmail or Calendar first. Reconnect accounts that need attention.',
    );
  };
  const requireReconnect = () => {
    const id = (['gmail', 'googlecalendar', 'googledrive', 'slack', 'notion'] as AppId[]).find(
      (app) => person.apps[app]?.length,
    );
    if (!id) {
      notice('Connect a demo account first.');
      return;
    }
    patch({
      apps: {
        ...person.apps,
        [id]: person.apps[id]!.map((connection, index) =>
          index === 0 ? { ...connection, status: 'attention' } : connection,
        ),
      },
    });
    setScreen('app');
    go('Apps');
  };
  const deliverSampleEvent = () => {
    const id = (['googlecalendar', 'gmail'] as const).find((app) =>
      person.apps[app]?.some((connection) => connection.status === 'ready'),
    );
    if (!id) {
      notice('Enable periodic updates for a connected Gmail or Calendar account first.');
      return;
    }
    const source = person.apps[id]!.find((connection) => connection.status === 'ready')!;
    const received = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: person.timezone,
    }).format(new Date());
    const text =
      id === 'googlecalendar'
        ? `Your 10:00 meeting on ${source.identity} moved to 10:30. There is a little more time to finish your proposal. This is a simulated Calendar event.`
        : `A new message arrived in the inbox for ${source.identity}: “Feedback on your proposal”. This is a simulated Gmail event.`;
    patch({
      apps: {
        ...person.apps,
        [id]: person.apps[id]!.map((connection) =>
          connection.id === source.id
            ? { ...connection, lastEvent: `${received} (${person.timezone})` }
            : connection,
        ),
      },
      messages: [...person.messages, { role: 'assistant', text }],
    });
    setScreen('app');
    go('Chat');
    notice('Sample event received and processed in this preview.');
  };
  const previewTelegram = (step: 'expired' | 'conflict') => {
    setReview(false);
    setSettingsOpen(false);
    setConnecting(null);
    setScreen('app');
    go('Channels');
    setTelegramStep(step);
    setModal('telegram');
  };
  const send = (text = draft) => {
    if (!text.trim()) return;
    const response = availableCount
      ? 'I can help with that. In the live product I would use only the accounts you connected. This preview shows the conversation flow; it has not read or sent anything.'
      : 'Let’s start here. Tell me what you’d like a hand with. You can connect your email or calendar whenever you need them.';
    patch({
      messages: [
        ...person.messages,
        { role: 'user', text: text.trim() },
        { role: 'assistant', text: response },
      ],
    });
    setDraft('');
  };
  const appRow = (app: (typeof apps)[number], compact = false) => {
    const connections = person.apps[app.id] ?? [];
    const periodic = app.id === 'gmail' || app.id === 'googlecalendar';
    return (
      <div key={app.id}>
        {!connections.length ? (
          <div className={`service-row ${compact ? 'compact' : ''}`}>
            <AppIcon id={app.id} />
            <div className="service-copy">
              <h3>{app.name}</h3>
              <p>{app.description}</p>
            </div>
            <Button onClick={() => startConnection(app.id)}>Connect</Button>
          </div>
        ) : (
          <>
            {connections.map((connection) => (
              <div className={`service-row ${compact ? 'compact' : ''}`} key={connection.id}>
                <AppIcon id={app.id} />
                <div className="service-copy">
                  <h3>{app.name}</h3>
                  <p>{connection.identity}</p>
                  {connection.status === 'pending' && (
                    <span className="small-status">
                      <Clock3 size={12} />
                      Connected · periodic updates being set up
                    </span>
                  )}
                  {connection.status === 'ready' && (
                    <span className="small-status good">
                      <Check size={12} />
                      {periodic ? 'Connected · periodic updates enabled' : 'Connected'}
                    </span>
                  )}
                  {connection.status === 'ready' && periodic && (
                    <p>
                      {connection.lastEvent
                        ? `Last simulated event: ${connection.lastEvent}`
                        : 'No events received yet'}
                    </p>
                  )}
                  {connection.status === 'attention' && (
                    <button
                      className="text-button warning"
                      onClick={() => startConnection(app.id, connection.id)}
                    >
                      Reconnect this account to resume access
                    </button>
                  )}
                </div>
                <button
                  className="icon-btn"
                  aria-label={`Disconnect ${app.name} account ${connection.identity}`}
                  onClick={() => {
                    setDisconnecting({ app: app.id, connection });
                    setModal('disconnect');
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            {!compact && (
              <div className="service-add">
                <button className="text-button" onClick={() => startConnection(app.id)}>
                  <Plus size={13} />
                  Add another {app.name} account
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };
  const profileContent = (
    <>
      <div className="profile-identity">
        <div className="avatar large">
          {person.name
            .split(' ')
            .map((s) => s[0])
            .slice(0, 2)
            .join('')}
        </div>
        <div>
          <h3>{person.name}</h3>
          <p>{person.email}</p>
          <span className="small-status">
            <GoogleMark /> Signed in with Google
          </span>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          patch({ name: editingName.trim() || person.name });
          notice('Profile saved in this preview.');
        }}
      >
        <label className="field">
          Name
          <input
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            required
            maxLength={80}
          />
        </label>
        <label className="field">
          Email
          <input value={person.email} readOnly />
          <span>Your email comes from your Google account.</span>
        </label>
        <label className="field">
          Time zone
          <select value={person.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
            <option>Europe/Lisbon</option>
            <option>Europe/London</option>
            <option>America/New_York</option>
          </select>
          <span>Used for your schedule and quiet hours.</span>
        </label>
        <Button primary type="submit">
          Save changes
        </Button>
      </form>
    </>
  );
  const settingsContent = (
    <>
      {settingsTab === 'Profile' && profileContent}
      {settingsTab === 'Appearance' && (
        <>
          <h3 className="section-heading">Make yourself at home</h3>
          <p className="muted section-intro">Choose how Sidekick looks on this device.</p>
          <div className="theme-options">
            {(['light', 'dark', 'system'] as Theme[]).map((theme) => {
              const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
              return (
                <button
                  key={theme}
                  aria-pressed={person.theme === theme}
                  className={`theme-choice ${person.theme === theme ? 'selected' : ''}`}
                  onClick={() => patch({ theme })}
                >
                  <span className={`theme-sample ${theme}`}>
                    <i />
                    <span>
                      <b />
                      <b />
                      <b />
                    </span>
                  </span>
                  <span>
                    <Icon size={15} />
                    {theme[0].toUpperCase() + theme.slice(1)}
                    {person.theme === theme && <Check size={15} />}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="subtle-note">
            Your choice applies immediately. Preview settings reset on reload.
          </p>
        </>
      )}
      {settingsTab === 'Preferences' && (
        <>
          <h3 className="section-heading">Keep the useful updates</h3>
          <p className="muted section-intro">
            Sidekick can notice relevant changes in your connected apps.
          </p>
          <div className="setting-row">
            <div>
              <strong>Quiet hours</strong>
              <p>Hold routine updates between 22:00 and 08:00.</p>
            </div>
            <button
              className={`toggle ${person.quiet ? 'on' : ''}`}
              role="switch"
              aria-checked={person.quiet}
              aria-label="Quiet hours"
              onClick={() => patch({ quiet: !person.quiet })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>Time zone</strong>
              <p>{person.timezone}</p>
            </div>
            <button className="text-button" onClick={() => setSettingsTab('Profile')}>
              Change
            </button>
          </div>
          <div className="plain-note">
            <MessageCircle size={18} />
            <p>You can also tell Sidekick what deserves your attention in chat.</p>
          </div>
        </>
      )}
      {settingsTab === 'Privacy' && (
        <>
          <h3 className="section-heading">Your space, your accounts</h3>
          <p className="muted section-intro">
            Your chats, files, app connections and computer belong to your account.
          </p>
          <div className="setting-row">
            <div>
              <strong>Connected accounts</strong>
              <p>Review access or disconnect an app.</p>
            </div>
            <Button
              onClick={() => {
                setSettingsOpen(false);
                go('Apps');
              }}
            >
              Manage apps
            </Button>
          </div>
          <div className="setting-row">
            <div>
              <strong>This session</strong>
              <p>Signed in as {person.email}</p>
            </div>
            <Button onClick={signOut}>
              <LogOut size={15} />
              Sign out
            </Button>
          </div>
          <div className="plain-note">
            <ShieldCheck size={18} />
            <p>
              Security and data-isolation behavior are design requirements. This UI prototype does
              not verify them.
            </p>
          </div>
        </>
      )}
    </>
  );
  const settingsPanel = (
    <div className="settings-layout">
      <nav aria-label="Account settings">
        {(['Profile', 'Appearance', 'Preferences', 'Privacy'] as const).map((tab) => (
          <button
            key={tab}
            aria-current={settingsTab === tab ? 'page' : undefined}
            className={settingsTab === tab ? 'active' : ''}
            onClick={() => setSettingsTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>
      <div className="settings-body">{settingsContent}</div>
    </div>
  );

  return (
    <>
      {screen === 'login' ? (
        <main className={`login-layout login-${variant}`}>
          <div className="login-main">
            <Logo />
            <div className="login-form">
              <span className="welcome-dot">
                <BrandMark />
              </span>
              <h1>Sign in to Sidekick</h1>
              <p>
                Your assistant, your accounts,
                <br />a little more room in your day.
              </p>
              {authError && (
                <div className="error-note" role="alert">
                  {authError}
                </div>
              )}
              <Button
                className="google-button"
                onClick={() => {
                  setAuthError('');
                  setModal('google');
                }}
              >
                <GoogleMark />
                Continue with Google
              </Button>
            </div>
          </div>
          <aside className="login-story">
            <div className="story-content">
              <div className="paper-note">
                <span className="note-date">26 September</span>
                <h2>
                  A clear start
                  <br />
                  to your day.
                </h2>
                <p>
                  Your first meeting is at 10:00.
                  <br />
                  There is time to finish the proposal first.
                </p>
                <div className="note-divider" />
                <div className="story-item">
                  <AppIcon id="googlecalendar" />
                  <div>
                    <strong>Design catch-up</strong>
                    <span>10:00 – 10:30</span>
                  </div>
                </div>
                <div className="story-item">
                  <AppIcon id="gmail" />
                  <div>
                    <strong>One reply worth a look</strong>
                    <span>The team shared feedback on your draft.</span>
                  </div>
                </div>
              </div>
              <p className="story-caption">A conversation that knows where you left off.</p>
            </div>
          </aside>
        </main>
      ) : screen === 'welcome' || screen === 'preferences' ? (
        <main className={`onboarding onboarding-${variant}`}>
          <header>
            <Logo />
            <button className="text-button" onClick={signOut}>
              Sign out
            </button>
          </header>
          <div className="onboarding-body">
            {variant === 'B' && (
              <div className="setup-progress">
                <span className="done">
                  <Check size={14} />
                  Account
                </span>
                <i />
                <span className={screen === 'welcome' ? 'current' : 'done'}>Apps</span>
                <i />
                <span className={screen === 'preferences' ? 'current' : ''}>Preferences</span>
              </div>
            )}
            {screen === 'welcome' ? (
              <>
                <div className="avatar greeting">{person.name[0]}</div>
                <h1>Welcome, {person.name.split(' ')[0]}.</h1>
                <p className="lead">Give your assistant a little context.</p>
                <p className="muted onboarding-explanation">
                  Connect the apps you want help with. You can add or remove accounts at any time.
                </p>
                <div className="onboarding-apps">
                  {apps.slice(0, 2).map((app) => appRow(app, true))}
                </div>
                <div className="plain-note">
                  <ShieldCheck size={17} />
                  <p>
                    You review access on Google’s consent screen. Background updates become
                    available after setup.
                  </p>
                </div>
                <div className="onboarding-actions">
                  <Button
                    primary
                    onClick={() => {
                      setScreen(variant === 'B' ? 'preferences' : 'app');
                      setPage('Chat');
                    }}
                  >
                    Continue{variant === 'B' ? '' : ' to Sidekick'}
                    <ArrowRight size={16} />
                  </Button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setScreen('app');
                      setPage('Chat');
                    }}
                  >
                    I’ll do this later
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1>At your pace.</h1>
                <p className="lead">A couple of preferences before you start.</p>
                <div className="onboarding-preferences">
                  <label className="field">
                    Time zone
                    <select
                      value={person.timezone}
                      onChange={(e) => patch({ timezone: e.target.value })}
                    >
                      <option>Europe/Lisbon</option>
                      <option>Europe/London</option>
                      <option>America/New_York</option>
                    </select>
                  </label>
                  <div className="setting-row">
                    <div>
                      <strong>Quiet hours</strong>
                      <p>Keep 22:00–08:00 clear of routine updates.</p>
                    </div>
                    <button
                      className={`toggle ${person.quiet ? 'on' : ''}`}
                      role="switch"
                      aria-label="Quiet hours"
                      aria-checked={person.quiet}
                      onClick={() => patch({ quiet: !person.quiet })}
                    >
                      <span />
                    </button>
                  </div>
                </div>
                <Button primary onClick={() => setScreen('app')}>
                  Start a conversation
                  <ArrowRight size={16} />
                </Button>
              </>
            )}
          </div>
          <footer>
            {person.email}
            <span>Only you can access this workspace</span>
          </footer>
        </main>
      ) : (
        <div className={`workspace variant-${variant}`}>
          <header className="mobile-header">
            <Logo />
            <button
              className="icon-btn"
              aria-label="Open navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={21} />
            </button>
          </header>
          <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
            <div className="sidebar-brand">
              <Logo />
              <button
                className="icon-btn close-nav"
                aria-label="Close navigation"
                onClick={() => setMobileNav(false)}
              >
                <PanelLeftClose size={18} />
              </button>
            </div>
            <nav aria-label="Main navigation">
              {nav.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  className={`nav-item ${page === name ? 'active' : ''}`}
                  aria-current={page === name ? 'page' : undefined}
                  onClick={() => go(name)}
                >
                  <Icon size={19} strokeWidth={1.7} />
                  {name}
                  {name === 'Apps' && connectedCount > 0 && (
                    <span className="nav-count">{connectedCount}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className={`computer-link ${page === 'Computer' ? 'active' : ''}`}
                onClick={() => go('Computer')}
              >
                <Monitor size={17} />
                <span>
                  Computer
                  <small>
                    {person.computer === 'asleep'
                      ? 'Ready when you need it'
                      : person.computer === 'manual'
                        ? 'You have control'
                        : person.computer === 'unavailable'
                          ? 'Needs attention'
                          : 'Available'}
                  </small>
                </span>
                <span
                  className={`status-dot ${person.computer === 'running' || person.computer === 'manual' ? 'online' : ''}`}
                />
              </button>
              {variant === 'B' && (
                <button
                  className={`nav-item ${page === 'Profile' || page === 'Settings' ? 'active' : ''}`}
                  onClick={() => openSettings('Profile')}
                >
                  <Settings size={18} />
                  Account & settings
                </button>
              )}
              <div className="account-anchor">
                {accountMenu && (
                  <div className="account-menu">
                    <div className="menu-identity">
                      <strong>{person.name}</strong>
                      <small>{person.email}</small>
                    </div>
                    <button onClick={() => openSettings('Profile')}>
                      <UserRound size={17} />
                      Profile
                    </button>
                    <button onClick={() => openSettings('Appearance')}>
                      <Settings size={17} />
                      Settings
                    </button>
                    <button onClick={signOut}>
                      <LogOut size={17} />
                      Sign out
                    </button>
                  </div>
                )}
                <button
                  className="account-button"
                  aria-label="Open account menu"
                  aria-expanded={accountMenu}
                  onClick={() => setAccountMenu(!accountMenu)}
                >
                  <span className="avatar">
                    {person.name
                      .split(' ')
                      .map((s) => s[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span>
                    <strong>{person.name}</strong>
                    <small>Personal account</small>
                  </span>
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>
          </aside>
          <main className={`main-content ${page === 'Chat' ? 'chat-page' : ''}`}>
            <header className="page-top">
              <span>{page === 'Chat' ? 'Your conversation' : page}</span>
              <span className="private-label">
                <LockKeyhole size={12} />
                Your private workspace
              </span>
            </header>
            {accessDenied ? (
              <div className="unavailable-page">
                <ShieldCheck size={32} />
                <h1>This item isn’t available</h1>
                <p>It may have been removed, or it isn’t part of your account.</p>
                <Button onClick={() => setAccessDenied(false)}>Back to my workspace</Button>
              </div>
            ) : page === 'Chat' ? (
              <>
                <div className="conversation">
                  <div className="conversation-heading">
                    <Logo word={false} />
                    <h1>
                      {person.messages.length
                        ? 'A little help, right here.'
                        : `What’s on your mind, ${person.name.split(' ')[0]}?`}
                    </h1>
                    <p>
                      {availableCount
                        ? 'Your connected accounts are ready to help.'
                        : connectedCount
                          ? 'Reconnect your apps when you need them. We can keep chatting here.'
                          : 'Make a plan, work through an idea, or take something off your list.'}
                    </p>
                  </div>
                  {!person.messages.length && (
                    <>
                      <div className="assistant-opening">
                        {variant === 'C' ? (
                          <>
                            <p>Welcome to your Sidekick. What would you like a hand with?</p>
                            <p className="muted">
                              If you want help with your day, connect Gmail or Calendar. We can do
                              that whenever you’re ready.
                            </p>
                            <Button onClick={() => go('Apps')}>
                              <PlugZap size={16} />
                              Connect an app
                            </Button>
                          </>
                        ) : (
                          <>
                            <p>
                              {availableCount
                                ? 'You’re all set to start. What would you like to do first?'
                                : 'We can start with a conversation. Your apps will be here when you need them.'}
                            </p>
                          </>
                        )}
                      </div>
                      <div className="suggestions">
                        <button onClick={() => send('Help me plan a focused day')}>
                          <Sun size={17} />
                          <span>Plan a focused day</span>
                          <ArrowRight size={15} />
                        </button>
                        <button onClick={() => send('Help me think through an idea')}>
                          <Sparkles size={17} />
                          <span>Think through an idea</span>
                          <ArrowRight size={15} />
                        </button>
                        <button
                          onClick={() => {
                            if (
                              !person.apps.gmail?.some(
                                (connection) => connection.status !== 'attention',
                              )
                            )
                              go('Apps');
                            else send('What needs my attention?');
                          }}
                        >
                          <MessageCircle size={17} />
                          <span>Catch up on what matters</span>
                          <ArrowRight size={15} />
                        </button>
                      </div>
                    </>
                  )}
                  {person.messages.map((message, i) => (
                    <div key={i} className={`message ${message.role}`}>
                      {message.role === 'assistant' && <Logo word={false} />}
                      <p>{message.text}</p>
                    </div>
                  ))}
                </div>
                <div className="composer-wrap">
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                  >
                    <textarea
                      aria-label="Message Sidekick"
                      placeholder="Ask Sidekick anything…"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    <div className="composer-tools">
                      <span>
                        <LockKeyhole size={13} />
                        Only in your workspace
                      </span>
                      <button
                        type="submit"
                        className="send-button"
                        aria-label="Send message"
                        disabled={!draft.trim()}
                      >
                        <ArrowRight size={19} />
                      </button>
                    </div>
                  </form>
                  <p className="composer-note">
                    Sidekick can make mistakes. Review important actions.
                  </p>
                </div>
              </>
            ) : (
              <div className="page-body">
                {page === 'Apps' && (
                  <>
                    <div className="page-heading">
                      <PlugZap size={26} />
                      <div>
                        <h1>Your apps</h1>
                        <p>Choose the accounts your assistant can work with.</p>
                      </div>
                    </div>
                    <div className="account-explainer">
                      <GoogleMark />
                      <p>
                        Signing in with Google connects your Sidekick account. Gmail and Calendar
                        need their own permission.
                      </p>
                    </div>
                    <div className="service-list">{apps.map((app) => appRow(app))}</div>
                    <p className="subtle-note">
                      Gmail inbox and primary-calendar updates are checked about every 15 minutes.
                      Enabling updates does not confirm an event has arrived.
                    </p>
                  </>
                )}
                {page === 'Channels' && (
                  <>
                    <div className="page-heading">
                      <Send size={26} />
                      <div>
                        <h1>Talk to Sidekick elsewhere</h1>
                        <p>Keep your assistant close, even with this tab closed.</p>
                      </div>
                    </div>
                    <div className="service-row">
                      <AppIcon id="telegram" />
                      <div className="service-copy">
                        <h3>Telegram</h3>
                        <p>
                          {person.telegram === 'none'
                            ? 'Connect your own bot to your private assistant.'
                            : telegramHandle}
                        </p>
                        {person.telegram !== 'none' && (
                          <span
                            className={`small-status ${person.telegram === 'tested' ? 'good' : ''}`}
                          >
                            {person.telegram === 'tested' ? (
                              <CheckCheck size={13} />
                            ) : (
                              <Clock3 size={13} />
                            )}
                            {person.telegram === 'tested'
                              ? 'Test reply received in this preview'
                              : 'Paired with your Telegram account'}
                          </span>
                        )}
                      </div>
                      <Button
                        onClick={() => {
                          setTelegramStep(person.telegram === 'none' ? 'token' : 'test');
                          setModal('telegram');
                        }}
                      >
                        {person.telegram === 'none' ? 'Connect' : 'Test connection'}
                      </Button>
                    </div>
                    <div className="plain-note">
                      <ShieldCheck size={18} />
                      <p>
                        Pairing links your Telegram account to Sidekick. Your bot only responds to
                        the account you verify.
                      </p>
                    </div>
                    {person.telegram !== 'none' && (
                      <button
                        className="text-button danger"
                        onClick={() => {
                          patch({ telegram: 'none' });
                          notice('Telegram disconnected in this preview.');
                        }}
                      >
                        Disconnect Telegram
                      </button>
                    )}
                  </>
                )}
                {page === 'Computer' && (
                  <>
                    <div className="page-heading">
                      <Monitor size={26} />
                      <div>
                        <h1>Your computer</h1>
                        <p>A separate place for Sidekick to browse and work for you.</p>
                      </div>
                    </div>
                    <div className="computer-summary">
                      <div>
                        <span
                          className={`status-dot ${person.computer === 'running' || person.computer === 'manual' ? 'online' : ''}`}
                        />
                        <strong>
                          {person.computer === 'asleep'
                            ? 'Resting until you need it'
                            : person.computer === 'manual'
                              ? 'You’re in control'
                              : person.computer === 'unavailable'
                                ? 'Unable to start your computer'
                                : 'Ready to work'}
                        </strong>
                        <p>{person.hostMode}. Available only to your account.</p>
                      </div>
                      {person.computer === 'asleep' || person.computer === 'unavailable' ? (
                        <Button primary onClick={() => patch({ computer: 'running' })}>
                          {person.computer === 'unavailable' ? 'Try again' : 'Start computer'}
                        </Button>
                      ) : (
                        <Button
                          onClick={() =>
                            patch({ computer: person.computer === 'manual' ? 'running' : 'manual' })
                          }
                        >
                          {person.computer === 'manual' ? (
                            <>
                              <ArrowRight size={15} />
                              Resume assistant
                            </>
                          ) : (
                            <>
                              <Pause size={15} />
                              Take control
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    <div
                      className={`computer-frame ${person.computer === 'asleep' || person.computer === 'unavailable' ? 'sleeping' : ''}`}
                    >
                      <div className="browser-chrome">
                        <div>
                          <i />
                          <i />
                          <i />
                        </div>
                        <span>
                          <LockKeyhole size={11} />
                          {person.computer === 'manual'
                            ? 'Private control · assistant paused'
                            : 'Your isolated browser'}
                        </span>
                      </div>
                      <div className="browser-canvas">
                        {person.computer === 'asleep' ? (
                          <>
                            <Moon size={34} />
                            <h3>Nothing running right now</h3>
                            <p>Sidekick starts the computer when a task needs it.</p>
                          </>
                        ) : person.computer === 'unavailable' ? (
                          <>
                            <CircleHelp size={34} />
                            <h3>Your work is still here</h3>
                            <p>Try starting the computer again in a moment.</p>
                          </>
                        ) : (
                          <>
                            <Logo />
                            <h3>
                              {person.computer === 'manual'
                                ? 'This space is yours for a moment.'
                                : 'Ready for your next task.'}
                            </h3>
                            <p>
                              {person.computer === 'manual'
                                ? 'The assistant waits while you use the browser. Resume it when you are ready.'
                                : 'Ask Sidekick to look something up or work on a file.'}
                            </p>
                            <span className="preview-tag">Simulated computer preview</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="plain-note">
                      <LockKeyhole size={18} />
                      <p>
                        Taking control pauses the assistant. Private sign-in details stay out of the
                        conversation.
                      </p>
                    </div>
                    <details className="advanced">
                      <summary>Computer options</summary>
                      <p>
                        Your host decides which providers are available. A change starts a new
                        computer; browser sign-ins do not move between providers.
                      </p>
                      <label className="field">
                        Available in this preview
                        <select
                          value={person.hostMode}
                          onChange={(e) => patch({ hostMode: e.target.value, computer: 'asleep' })}
                        >
                          <option>Managed cloud computer</option>
                          <option>Local Docker computer</option>
                          <option>Alternative cloud provider</option>
                        </select>
                      </label>
                    </details>
                  </>
                )}
                {(page === 'Profile' || page === 'Settings') && (
                  <>
                    <div className="page-heading">
                      <UserRound size={26} />
                      <div>
                        <h1>Account & settings</h1>
                        <p>Make Sidekick feel like your own.</p>
                      </div>
                    </div>
                    {settingsPanel}
                  </>
                )}
                {page === 'Goals' && (
                  <>
                    <div className="page-heading">
                      <Goal size={26} />
                      <div>
                        <h1>Your goals</h1>
                        <p>A place for the things you want to move forward.</p>
                      </div>
                    </div>
                    <div className="quiet-empty">
                      <Goal size={30} />
                      <h3>Start with something you care about</h3>
                      <p>Tell Sidekick what you are working towards.</p>
                      <Button
                        onClick={() => {
                          go('Chat');
                          setDraft('I’d like help working towards ');
                        }}
                      >
                        Talk about a goal
                      </Button>
                    </div>
                  </>
                )}
                {page === 'Schedule' && (
                  <>
                    <div className="page-heading">
                      <Clock3 size={26} />
                      <div>
                        <h1>Your schedule</h1>
                        <p>Follow-ups and recurring work, in {person.timezone}.</p>
                      </div>
                    </div>
                    <div className="quiet-empty">
                      <Clock3 size={30} />
                      <h3>No scheduled work yet</h3>
                      <p>Ask Sidekick to check back on something for you.</p>
                      <Button
                        onClick={() => {
                          go('Chat');
                          setDraft('Every weekday morning, help me ');
                        }}
                      >
                        Schedule something in chat
                      </Button>
                    </div>
                  </>
                )}
                {page === 'Vault' && (
                  <>
                    <div className="page-heading">
                      <KeyRound size={26} />
                      <div>
                        <h1>Your vault</h1>
                        <p>Private details for the websites you choose to use.</p>
                      </div>
                    </div>
                    <div className="quiet-empty">
                      <LockKeyhole size={30} />
                      <h3>Your vault is empty</h3>
                      <p>
                        Existing secure forms will become account-scoped. This design preview does
                        not collect or store secrets.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </main>
          {settingsOpen && variant === 'C' && (
            <aside className="settings-drawer" aria-label="Account settings panel">
              <header>
                <h2>Account & settings</h2>
                <button
                  className="icon-btn"
                  aria-label="Close settings"
                  onClick={() => setSettingsOpen(false)}
                >
                  <X size={19} />
                </button>
              </header>
              {settingsPanel}
            </aside>
          )}
        </div>
      )}
      {settingsOpen && variant === 'A' && (
        <Modal title="Account & settings" close={() => setSettingsOpen(false)} wide>
          {settingsPanel}
        </Modal>
      )}
      {modal === 'google' && (
        <Modal title="Choose a demo account" close={() => setModal(null)}>
          <div className="modal-body">
            <div className="demo-note">
              <FlaskConical size={17} />
              <p>This is a simulated sign-in. No Google account is accessed.</p>
            </div>
            <div className="demo-accounts">
              {(['alex', 'sam'] as AccountId[]).map((id) => (
                <button key={id} onClick={() => enter(id)}>
                  <span className="avatar">{people[id].name[0]}</span>
                  <span>
                    <strong>{people[id].name}</strong>
                    <small>{people[id].email}</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
            <button
              className="text-button"
              onClick={() => {
                setModal(null);
                setAuthError('Google sign-in was cancelled. You can try again when you’re ready.');
              }}
            >
              Preview cancelled sign-in
            </button>
          </div>
        </Modal>
      )}
      {connecting && (
        <Modal
          title={`${reconnecting ? 'Reconnect' : 'Connect'} ${apps.find((a) => a.id === connecting)?.name}`}
          close={() => {
            setConnecting(null);
            setReconnecting(null);
            setConnectionError('');
          }}
        >
          <div className="modal-body">
            <div className="connect-heading">
              <AppIcon id={connecting} />
              <div>
                <h3>Choose what your assistant can access</h3>
                <p>
                  {['gmail', 'googlecalendar', 'googledrive'].includes(connecting)
                    ? 'You can use a different Google account from the one you signed in with.'
                    : `Choose the ${apps.find((a) => a.id === connecting)?.name} account or workspace you want to connect.`}
                </p>
              </div>
            </div>
            <ul className="permission-list">
              {apps
                .find((a) => a.id === connecting)
                ?.access.map((access) => (
                  <li key={access}>
                    <Check size={16} />
                    {access}
                  </li>
                ))}
            </ul>
            <div className="demo-note">
              <FlaskConical size={17} />
              <p>
                The live app will open provider consent through Composio. This preview uses the
                fictional account{' '}
                {(person.apps[connecting] ?? []).find(
                  (connection) => connection.id === reconnecting,
                )?.identity ?? nextIdentity(connecting)}
                .
              </p>
            </div>
            {connectionError && (
              <div className="error-note" role="alert">
                {connectionError}
              </div>
            )}
            <button
              className="text-button"
              onClick={() =>
                setConnectionError(
                  'Access was not granted. Your existing connections are unchanged. You can try again when you are ready.',
                )
              }
            >
              Preview denied consent
            </button>
            <div className="modal-actions">
              <Button
                onClick={() => {
                  setConnecting(null);
                  setReconnecting(null);
                  setConnectionError('');
                  notice('Connection cancelled. Nothing changed.');
                }}
              >
                Cancel
              </Button>
              <Button primary onClick={() => connect(connecting)}>
                {connectionError ? 'Try simulated consent again' : 'Simulate connection'}
                <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal === 'disconnect' && disconnecting && (
        <Modal
          title={`Disconnect ${apps.find((a) => a.id === disconnecting.app)?.name}?`}
          close={() => {
            setModal(null);
            setDisconnecting(null);
          }}
        >
          <div className="modal-body">
            <p>
              Sidekick will stop using <strong>{disconnecting.connection.identity}</strong> and
              receiving its background updates. Other connected accounts and your existing
              conversation stay.
            </p>
            <div className="modal-actions">
              <Button
                onClick={() => {
                  setModal(null);
                  setDisconnecting(null);
                }}
              >
                Keep account
              </Button>
              <Button
                onClick={() => {
                  patch({
                    apps: {
                      ...person.apps,
                      [disconnecting.app]: (person.apps[disconnecting.app] ?? []).filter(
                        (connection) => connection.id !== disconnecting.connection.id,
                      ),
                    },
                  });
                  setModal(null);
                  setDisconnecting(null);
                  notice('This account was disconnected in the preview.');
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal === 'telegram' && (
        <Modal
          title="Connect Telegram"
          close={() => {
            setModal(null);
            setTelegramStep('token');
          }}
        >
          <div className="modal-body">
            <div className="step-label">
              Step{' '}
              {telegramStep === 'token' || telegramStep === 'conflict'
                ? 1
                : telegramStep === 'waiting' || telegramStep === 'expired'
                  ? 2
                  : telegramStep === 'confirm'
                    ? 3
                    : 4}{' '}
              of 4
            </div>
            {telegramStep === 'token' ? (
              <>
                <AppIcon id="telegram" />
                <h3 className="section-heading">Bring your own bot</h3>
                <p>Open @BotFather in Telegram, send /newbot, and follow its instructions.</p>
                <label className="field">
                  Bot token
                  <input type="password" readOnly value="demo-token-not-a-real-secret" />
                  <span>
                    In the live app this goes to a secure server form, never into chat. A working
                    token verifies your bot; pairing verifies you.
                  </span>
                </label>
                <div className="demo-note">
                  <FlaskConical size={17} />
                  <p>A demo token is filled in. Do not enter a real token into this prototype.</p>
                </div>
                <Button primary onClick={() => setTelegramStep('waiting')}>
                  Use demo bot
                  <ArrowRight size={15} />
                </Button>
              </>
            ) : telegramStep === 'waiting' ? (
              <>
                <Link2 size={30} />
                <h3 className="section-heading">Open your bot in Telegram</h3>
                <p>
                  In the live app, open Sidekick’s one-time pairing link and press Start. Then
                  return here to confirm the Telegram identity we observed.
                </p>
                <div className="pairing-card">
                  <AppIcon id="telegram" />
                  <div>
                    <strong>{telegramHandle}</strong>
                    <small>Pairing link expires in 10 minutes</small>
                  </div>
                </div>
                <div className="plain-note">
                  <Clock3 size={17} />
                  <p>
                    Waiting for you to press Start. Your assistant cannot respond through this bot
                    until you confirm the identity.
                  </p>
                </div>
                <Button primary onClick={() => setTelegramStep('confirm')}>
                  Simulate pressing Start in Telegram
                </Button>
              </>
            ) : telegramStep === 'confirm' ? (
              <>
                <ShieldCheck size={30} />
                <h3 className="section-heading">Is this your Telegram account?</h3>
                <p>
                  We observed this identity opening the pairing link. Confirm it here before linking
                  your assistant.
                </p>
                <div className="pairing-card">
                  <span className="avatar">{telegramIdentity[0]}</span>
                  <div>
                    <strong>{telegramIdentity}</strong>
                    <small>Fictional identity: demo-telegram-{account}</small>
                    <small>Bot: {telegramHandle}</small>
                  </div>
                </div>
                <div className="plain-note">
                  <LockKeyhole size={17} />
                  <p>
                    No assistant data has been shared. Only this confirmed private chat will have
                    access.
                  </p>
                </div>
                <div className="modal-actions">
                  <Button onClick={() => setTelegramStep('waiting')}>This isn’t me</Button>
                  <Button
                    primary
                    onClick={() => {
                      patch({ telegram: 'paired' });
                      setTelegramStep('test');
                    }}
                  >
                    Confirm {telegramIdentity.split(' ')[0]}
                  </Button>
                </div>
              </>
            ) : telegramStep === 'expired' ? (
              <>
                <Clock3 size={30} />
                <h3 className="section-heading">This pairing link expired</h3>
                <p>
                  It can no longer link a Telegram account.{' '}
                  {person.telegram === 'none'
                    ? 'Nothing has been paired.'
                    : 'Your existing connection is unchanged.'}
                </p>
                <div className="modal-actions">
                  <Button onClick={() => setModal(null)}>Cancel</Button>
                  <Button primary onClick={() => setTelegramStep('waiting')}>
                    Create new demo pairing link
                  </Button>
                </div>
              </>
            ) : telegramStep === 'conflict' ? (
              <>
                <ShieldCheck size={30} />
                <h3 className="section-heading">This bot is already in use</h3>
                <p>
                  It is linked elsewhere or has a webhook managed by another app. Sidekick will not
                  replace that connection during setup.
                </p>
                <div className="plain-note">
                  <LockKeyhole size={17} />
                  <p>
                    Use a separate bot for this account and environment. A deliberate bot move needs
                    its own confirmed setup.
                  </p>
                </div>
                <div className="modal-actions">
                  <Button onClick={() => setModal(null)}>Cancel</Button>
                  <Button primary onClick={() => setTelegramStep('token')}>
                    Use a different demo bot
                  </Button>
                </div>
              </>
            ) : (
              <>
                <CheckCheck size={32} className="success-icon" />
                <h3 className="section-heading">
                  {person.telegram === 'tested'
                    ? 'Your test reply arrived.'
                    : 'Paired. Try a conversation.'}
                </h3>
                <p>
                  {person.telegram === 'tested'
                    ? 'This preview simulates a complete exchange with your paired Telegram account.'
                    : 'Send “Hello Sidekick” in Telegram. After the assistant responds, reply there to confirm you received it.'}
                </p>
                <div className="telegram-transcript">
                  <div>Hello Sidekick</div>
                  {person.telegram === 'tested' ? (
                    <>
                      <p>Hi {telegramIdentity.split(' ')[0]}. You’re connected to your Sidekick.</p>
                      <div>I received your reply.</div>
                    </>
                  ) : (
                    <span>
                      <Clock3 size={14} />
                      Waiting for a test exchange
                    </span>
                  )}
                </div>
                <div className="demo-note">
                  <FlaskConical size={17} />
                  <p>
                    This delivery is simulated. No Telegram message is sent. API acceptance alone
                    would not confirm you received a reply.
                  </p>
                </div>
                {person.telegram === 'tested' ? (
                  <Button primary onClick={() => setModal(null)}>
                    Done
                  </Button>
                ) : (
                  <Button primary onClick={() => patch({ telegram: 'tested' })}>
                    Simulate received reply and confirmation
                  </Button>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {import.meta.env.DEV && (
        <>
          <div className="prototype-toolbar">
            <span className="prototype-label">
              <FlaskConical size={14} />
              Prototype
            </span>
            <button aria-label="Previous variant" onClick={() => cycle(-1)}>
              <ChevronLeft size={17} />
            </button>
            <span className="variant-label">
              {variant} · {variants[variant].title}
            </span>
            <button aria-label="Next variant" onClick={() => cycle(1)}>
              <ChevronRight size={17} />
            </button>
            <span className="toolbar-divider" />
            <button
              className={review ? 'selected' : ''}
              aria-label="Open prototype scenarios"
              onClick={() => setReview(!review)}
            >
              <SlidersHorizontal size={16} />
              <span>Scenarios</span>
            </button>
          </div>
          {review && (
            <aside className="review-panel" aria-label="Prototype scenarios">
              <header>
                <h3>Review this direction</h3>
                <button
                  className="icon-btn"
                  aria-label="Close scenarios"
                  onClick={() => setReview(false)}
                >
                  <X size={17} />
                </button>
              </header>
              <p>{variants[variant].detail}</p>
              <span className="review-note">
                All accounts, events, messages and computers are simulated. No backend or provider
                calls.
              </span>
              <div className="scenario-actions">
                <Button
                  onClick={() => {
                    signOut();
                    setReview(false);
                  }}
                >
                  Restart sign-in
                </Button>
                {account && (
                  <>
                    <Button
                      onClick={() => {
                        setScreen('welcome');
                        setReview(false);
                      }}
                    >
                      Review onboarding
                    </Button>
                    <Button
                      onClick={() => {
                        setSettingsOpen(false);
                        setModal('google');
                        setReview(false);
                      }}
                    >
                      Switch demo user
                    </Button>
                    <Button onClick={advanceAppSetup}>Advance app setup</Button>
                    <Button onClick={requireReconnect}>App needs reconnection</Button>
                    <Button onClick={deliverSampleEvent}>Deliver sample event</Button>
                    <Button
                      onClick={() => {
                        setScreen('app');
                        go('Apps');
                        startConnection('gmail');
                        setConnectionError(
                          'The provider declined access. Your existing accounts are unchanged.',
                        );
                        setReview(false);
                      }}
                    >
                      Provider denied consent
                    </Button>
                    <Button onClick={() => previewTelegram('expired')}>
                      Telegram pairing expired
                    </Button>
                    <Button onClick={() => previewTelegram('conflict')}>
                      Telegram bot already linked
                    </Button>
                    <Button
                      onClick={() => {
                        patch({ computer: 'unavailable' });
                        setScreen('app');
                        go('Computer');
                      }}
                    >
                      Computer unavailable
                    </Button>
                    <Button
                      onClick={() => {
                        setScreen('app');
                        setAccessDenied(true);
                      }}
                    >
                      Open unavailable item
                    </Button>
                    <Button
                      onClick={() => {
                        signOut();
                        setAuthError(
                          'Your session expired. Sign in again to continue in your workspace.',
                        );
                        setReview(false);
                      }}
                    >
                      Session expired
                    </Button>
                  </>
                )}
                <Button
                  onClick={() => {
                    setPeople(freshPeople());
                    signOut();
                    setReview(false);
                  }}
                >
                  Reset all demo data
                </Button>
              </div>
              <details>
                <summary>Current prototype state</summary>
                <pre>
                  {JSON.stringify(
                    {
                      variant,
                      screen,
                      page,
                      account,
                      theme: person.theme,
                      apps: person.apps,
                      telegram: person.telegram,
                      computer: person.computer,
                      hostMode: person.hostMode,
                      messages: person.messages.length,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </aside>
          )}
        </>
      )}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
