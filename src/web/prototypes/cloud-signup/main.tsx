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
  PanelLeftOpen,
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
import alexPicture from './avatars/alex.svg';
import samPicture from './avatars/sam.svg';

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
type AppId =
  'gmail' | 'googlecalendar' | 'googledrive' | 'googledocs' | 'googlesheets' | 'slack' | 'notion';
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
  picture: string;
  theme: Theme;
  timezone: string;
  quiet: boolean;
  apps: Partial<Record<AppId, Connection[]>>;
  telegram: 'none' | 'paired' | 'tested';
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
const apps: { id: AppId; name: string; description: string }[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Find emails and stay on top of replies.',
  },
  {
    id: 'googlecalendar',
    name: 'Google Calendar',
    description: 'Make time for what is coming up.',
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    description: 'Bring your files into the conversation.',
  },
  {
    id: 'googledocs',
    name: 'Google Docs',
    description: 'Create and edit documents.',
  },
  {
    id: 'googlesheets',
    name: 'Google Sheets',
    description: 'Work with your spreadsheets.',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Catch up on the conversations that matter.',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Work with the pages you choose to share.',
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
    picture: alexPicture,
    theme: 'system',
    timezone: 'Europe/Lisbon',
    quiet: true,
    apps: {},
    telegram: 'none',
    computer: 'asleep',
    messages: [],
  },
  sam: {
    name: 'Sam Rivera',
    email: 'sam@example.test',
    picture: samPicture,
    theme: 'system',
    timezone: 'Europe/London',
    quiet: true,
    apps: {},
    telegram: 'none',
    computer: 'asleep',
    messages: [],
  },
});

function Avatar({ person, size = '' }: { person: Person; size?: 'large' | 'greeting' | '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [person.picture]);
  return (
    <span className={`avatar ${size}`}>
      {person.picture && !failed ? (
        <img
          src={person.picture}
          alt={person.name}
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
        />
      ) : (
        person.name
          .split(' ')
          .map((part) => part[0])
          .slice(0, 2)
          .join('')
      )}
    </span>
  );
}
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
  className = '',
  returnFocus,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
  className?: string;
  returnFocus?: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      const target = returnFocus?.() ?? (previous?.isConnected ? previous : null);
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''} ${className}`}
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
  const [settingsTab, setSettingsTab] = useState<'Profile' | 'Appearance' | 'Preferences'>(
    'Profile',
  );
  const [accountMenu, setAccountMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [developerEnabled, setDeveloperEnabled] = useState(
    import.meta.env.DEV && new URLSearchParams(location.search).get('developer') === '1',
  );
  const developer = import.meta.env.DEV && developerEnabled;
  const computerProvider = import.meta.env.VITE_PROTOTYPE_COMPUTER_PROVIDER || 'Cloud computer';
  const navigationButton = useRef<HTMLButtonElement>(null);
  const accountAnchor = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLElement | null>(null);
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
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const startConnection = (id: AppId, connectionId: string | null = null) => {
    if (connecting) return;
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
  useEffect(() => {
    const viewport = matchMedia('(max-width: 640px)');
    const closeOnDesktop = () => {
      if (!viewport.matches) setMobileNav(false);
    };
    viewport.addEventListener('change', closeOnDesktop);
    return () => viewport.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!accountMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!accountAnchor.current?.contains(event.target as Node)) setAccountMenu(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [accountMenu]);
  const closeMobileNav = () => {
    setMobileNav(false);
    navigationButton.current?.focus();
  };
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
        e.defaultPrevented ||
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
        closeMobileNav();
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
    if (next === 'Computer' && !developer) return;
    setPage(next);
    setMobileNav(false);
    setAccountMenu(false);
    setAccessDenied(false);
  };
  const openSettings = (tab: typeof settingsTab, trigger?: HTMLElement) => {
    settingsTrigger.current =
      (trigger && !trigger.closest('.account-menu,.sidebar.mobile-open,.review-panel')
        ? trigger
        : null) ??
      (mobileNav
        ? navigationButton.current
        : (accountAnchor.current?.querySelector<HTMLButtonElement>('.account-button') ?? null));
    setSettingsTab(tab);
    setEditingName(person.name);
    setAccountMenu(false);
    setMobileNav(false);
    if (variant === 'B') go(tab === 'Profile' ? 'Profile' : 'Settings');
    else setSettingsOpen(true);
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key !== ',' ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        !account ||
        screen !== 'app' ||
        modal
      )
        return;
      event.preventDefault();
      if (settingsOpen || event.repeat) return;
      setReview(false);
      openSettings('Profile', document.activeElement as HTMLElement);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [account, screen, modal, settingsOpen, variant, mobileNav, person.name, isMac]);
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
  useEffect(() => {
    if (!connecting || !account) return;
    const timer = setTimeout(() => {
      const id = `demo-connection-${++connectionSequence.current}`;
      setPeople((current) => {
        const owner = current[account];
        const existing = owner.apps[connecting] ?? [];
        const status: Connection['status'] =
          connecting === 'gmail' || connecting === 'googlecalendar' ? 'pending' : 'ready';
        const identities = new Set(existing.map((connection) => connection.identity));
        let identity = owner.email;
        let index = 1;
        while (identities.has(identity)) {
          identity = `${account}.work${index > 1 ? index : ''}@example.test`;
          index++;
        }
        const connections = reconnecting
          ? existing.map((connection) =>
              connection.id === reconnecting
                ? { ...connection, status, lastEvent: null }
                : connection,
            )
          : [...existing, { id, identity, status, lastEvent: null }];
        return {
          ...current,
          [account]: { ...owner, apps: { ...owner.apps, [connecting]: connections } },
        };
      });
      setConnecting(null);
      setReconnecting(null);
      setConnectionError('');
      notice(`${apps.find((app) => app.id === connecting)?.name} connected.`);
    }, 650);
    return () => clearTimeout(timer);
  }, [account, connecting, reconnecting]);
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
    notice(changed ? 'App setup complete.' : 'Connect Gmail or Calendar first.');
  };
  const requireReconnect = () => {
    const id = apps.find((app) => person.apps[app.id]?.length)?.id;
    if (!id) {
      notice('Connect an account first.');
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
    if (screen !== 'welcome') {
      setScreen('app');
      go('Apps');
    }
  };
  const deliverSampleEvent = () => {
    const id = (['googlecalendar', 'gmail'] as const).find((app) =>
      person.apps[app]?.some((connection) => connection.status === 'ready'),
    );
    if (!id) {
      notice('Complete app setup first.');
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
        ? `Your 10:00 meeting on ${source.identity} moved to 10:30. There is a little more time to finish your proposal.`
        : `A new message arrived in the inbox for ${source.identity}: “Feedback on your proposal”.`;
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
    notice('Event received.');
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
      ? 'Let’s make a plan. What would you like to focus on first?'
      : 'What would you like a hand with?';
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
    if (compact) {
      const connected = connections.some((connection) => connection.status !== 'attention');
      const attention =
        !connected && connections.some((connection) => connection.status === 'attention');
      const pending = connecting === app.id;
      const status = pending
        ? 'Connecting…'
        : connected
          ? 'Connected'
          : attention
            ? 'Reconnect'
            : 'Connect';
      return (
        <button
          key={app.id}
          type="button"
          data-app-id={app.id}
          className={`onboarding-app-card ${connected ? 'connected' : ''} ${attention ? 'attention' : ''}`}
          disabled={connected || Boolean(connecting)}
          aria-label={`${app.name}: ${status}`}
          aria-busy={pending}
          onClick={() => startConnection(app.id, attention ? connections[0].id : null)}
        >
          <AppIcon id={app.id} />
          <span className="onboarding-app-name">{app.name}</span>
          <span className="onboarding-app-status">
            {connected && <Check size={15} aria-hidden="true" />}
            {status}
          </span>
        </button>
      );
    }
    return (
      <div key={app.id} data-app-id={app.id} className="app-card">
        <div className="service-row">
          <AppIcon id={app.id} />
          <div className="service-copy">
            <h3>{app.name}</h3>
            {!connections.length && <p>{app.description}</p>}
          </div>
          {connections.length ? (
            <button
              className="icon-btn"
              aria-label={`Add ${app.name} account`}
              title="Add account"
              disabled={Boolean(connecting)}
              onClick={() => startConnection(app.id)}
            >
              <Plus size={17} />
            </button>
          ) : (
            <Button disabled={Boolean(connecting)} onClick={() => startConnection(app.id)}>
              {connecting === app.id ? 'Opening…' : 'Connect'}
            </Button>
          )}
        </div>
        {connections.length > 0 && (
          <div className="app-account-list">
            {connections.map((connection) => (
              <div className="service-row connected-account" key={connection.id}>
                <div className="service-copy">
                  <p>{connection.identity}</p>
                  {connection.status === 'attention' ? (
                    <button
                      className="text-button warning"
                      disabled={Boolean(connecting)}
                      onClick={() => startConnection(app.id, connection.id)}
                    >
                      Reconnect
                    </button>
                  ) : (
                    <span className="small-status good">
                      <Check size={12} />
                      Connected
                    </span>
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
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };
  const profileContent = (
    <>
      <form
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          const name = editingName.trim();
          if (!name) return;
          patch({ name });
          setEditingName(name);
          notice('Profile saved.');
        }}
      >
        <div className="profile-identity">
          <Avatar person={person} size="large" />
          <label className="field">
            Display name
            <input
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              autoComplete="name"
              required
              maxLength={80}
            />
          </label>
        </div>
        <div className="profile-email">
          <span>Email</span>
          <div>
            <GoogleMark />
            <span>{person.email}</span>
          </div>
        </div>
        {editingName.trim() !== person.name && (
          <div className="profile-actions">
            <Button onClick={() => setEditingName(person.name)}>Cancel</Button>
            <Button primary type="submit" disabled={!editingName.trim()}>
              Save changes
            </Button>
          </div>
        )}
      </form>
    </>
  );
  const settingsContent = (
    <>
      {settingsTab === 'Profile' && profileContent}
      {settingsTab === 'Appearance' && (
        <div className="settings-appearance">
          <div className="theme-options" role="group" aria-label="Theme">
            {(['light', 'dark', 'system'] as Theme[]).map((theme) => {
              const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
              return (
                <button
                  key={theme}
                  aria-pressed={person.theme === theme}
                  aria-label={`${theme[0].toUpperCase() + theme.slice(1)} theme`}
                  className={`theme-choice ${person.theme === theme ? 'selected' : ''}`}
                  onClick={() => patch({ theme })}
                >
                  <span className={`theme-sample ${theme}`} aria-hidden="true">
                    <i>
                      <em />
                      <em />
                      <em />
                    </i>
                    <span>
                      <b />
                      <b />
                      <b />
                      <em />
                    </span>
                  </span>
                  <span className="theme-choice-label">
                    <Icon size={15} />
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {settingsTab === 'Preferences' && (
        <div className="settings-preferences">
          <label className="settings-preference-row">
            <span>
              <Clock3 size={18} aria-hidden="true" />
              Time zone
            </span>
            <select value={person.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
              <option value="Europe/Lisbon">Lisbon</option>
              <option value="Europe/London">London</option>
              <option value="America/New_York">New York</option>
            </select>
          </label>
          <div className="settings-preference-row">
            <div className="settings-preference-label">
              <Moon size={18} aria-hidden="true" />
              <div>
                <strong>Quiet hours</strong>
                <p>22:00–08:00</p>
              </div>
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
        </div>
      )}
    </>
  );
  const settingsPanel = (
    <div className="settings-layout">
      <nav
        className="settings-nav"
        role="tablist"
        aria-label="Account settings"
        aria-orientation="vertical"
      >
        {(['Profile', 'Appearance', 'Preferences'] as const).map((tab, index, tabs) => {
          const Icon =
            tab === 'Profile' ? UserRound : tab === 'Appearance' ? Sun : SlidersHorizontal;
          return (
            <button
              key={tab}
              id={`settings-tab-${tab.toLowerCase()}`}
              role="tab"
              aria-selected={settingsTab === tab}
              aria-label={tab}
              aria-controls="settings-content"
              title={tab}
              tabIndex={settingsTab === tab ? 0 : -1}
              className={settingsTab === tab ? 'active' : ''}
              onClick={() => setSettingsTab(tab)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowDown' || event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                      ? (index - 1 + tabs.length) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setSettingsTab(tabs[next]);
                document.getElementById(`settings-tab-${tabs[next].toLowerCase()}`)?.focus();
              }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{tab}</span>
            </button>
          );
        })}
      </nav>
      <div
        className="settings-body"
        id="settings-content"
        role="tabpanel"
        aria-labelledby={`settings-tab-${settingsTab.toLowerCase()}`}
        tabIndex={0}
      >
        <h3 className="settings-section-title">{settingsTab}</h3>
        {settingsContent}
      </div>
      <div className="settings-signout">
        <button className="text-button" aria-label="Sign out" title="Sign out" onClick={signOut}>
          <LogOut size={16} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
  const quickTheme = (
    <div className="account-theme" role="group" aria-label="Theme">
      <span>Theme</span>
      <div className="account-theme-options">
        {(['light', 'dark', 'system'] as Theme[]).map((theme) => {
          const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
          const label = theme[0].toUpperCase() + theme.slice(1);
          return (
            <button
              key={theme}
              type="button"
              title={label}
              aria-label={`${label} theme`}
              aria-pressed={person.theme === theme}
              onClick={() => patch({ theme })}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
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
                Hand off the work you keep putting off.
                <br />
                Sidekick gets it done while you sleep.
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
                <span className="note-date">Today, 07:30</span>
                <h2>
                  Ready when
                  <br />
                  you wake up.
                </h2>
                <div className="note-divider" />
                <div className="story-item">
                  <AppIcon id="googledocs" />
                  <div>
                    <strong>Supplier comparison</strong>
                    <span>Prices, trade-offs and a recommendation.</span>
                  </div>
                </div>
                <div className="story-item">
                  <AppIcon id="gmail" />
                  <div>
                    <strong>Follow-ups drafted</strong>
                    <span>Ready for your review.</span>
                  </div>
                </div>
              </div>
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
                <Avatar person={person} size="greeting" />
                <h1>Welcome, {person.name.split(' ')[0]}.</h1>
                <p className="lead">Connect your apps.</p>
                {connectionError && (
                  <div className="error-note" role="alert">
                    {connectionError}
                  </div>
                )}
                <div className="onboarding-apps">{apps.map((app) => appRow(app, true))}</div>
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
                <h1>Your preferences</h1>
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
                      <p>22:00–08:00</p>
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
          <footer>{person.email}</footer>
        </main>
      ) : (
        <div
          className={`workspace variant-${variant} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        >
          <header className="mobile-header">
            <Logo />
            <button
              ref={navigationButton}
              className="icon-btn"
              aria-label={mobileNav ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileNav}
              aria-controls="main-sidebar"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={21} />
            </button>
          </header>
          {mobileNav && (
            <button
              className="mobile-nav-backdrop"
              aria-label="Close navigation"
              onClick={closeMobileNav}
            />
          )}
          <aside id="main-sidebar" className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
            <div className="sidebar-brand">
              <Logo />
              <button
                className="icon-btn sidebar-toggle"
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
              <button
                className="icon-btn sidebar-mobile-close"
                aria-label="Close navigation"
                onClick={closeMobileNav}
              >
                <X size={20} />
              </button>
            </div>
            <div className="mobile-account-header">
              <Avatar person={person} />
              <div>
                <strong>{person.name}</strong>
                <small>{person.email}</small>
              </div>
            </div>
            <nav className="sidebar-nav" aria-label="Main navigation">
              {nav.map(({ name, icon: Icon }) => (
                <button
                  key={name}
                  className={`nav-item ${page === name ? 'active' : ''}`}
                  aria-label={name}
                  title={name}
                  aria-current={page === name ? 'page' : undefined}
                  onClick={() => go(name)}
                >
                  <span className="nav-icon">
                    <Icon size={19} strokeWidth={1.7} />
                  </span>
                  <span className="nav-label">{name}</span>
                </button>
              ))}
            </nav>
            <button
              className="mobile-settings-link nav-item"
              onClick={() => openSettings('Profile')}
            >
              <span className="nav-icon">
                <Settings size={19} />
              </span>
              <span className="nav-label">Settings</span>
            </button>
            <div className="mobile-account-theme">{quickTheme}</div>
            <div className="sidebar-bottom">
              {developer && (
                <button
                  className={`computer-link ${page === 'Computer' ? 'active' : ''}`}
                  title="Computer"
                  aria-label="Computer"
                  onClick={() => go('Computer')}
                >
                  <span className="nav-icon">
                    <Monitor size={17} />
                  </span>
                  <span className="nav-label">Computer</span>
                  <span
                    className={`status-dot ${person.computer === 'running' || person.computer === 'manual' ? 'online' : ''}`}
                  />
                </button>
              )}
              <div className="account-anchor" ref={accountAnchor}>
                {accountMenu && (
                  <div className="account-menu">
                    <div className="menu-identity">
                      <Avatar person={person} />
                      <div>
                        <strong>{person.name}</strong>
                        <small>{person.email}</small>
                      </div>
                    </div>
                    <button onClick={() => openSettings('Profile')}>
                      <Settings size={17} />
                      Settings
                      <kbd className="settings-shortcut">{isMac ? '⌘,' : 'Ctrl+,'}</kbd>
                    </button>
                    {quickTheme}
                    <button onClick={signOut}>
                      <LogOut size={17} />
                      Sign out
                    </button>
                  </div>
                )}
                <button
                  className="account-button"
                  aria-label={`Open account menu for ${person.name}`}
                  title={person.name}
                  aria-expanded={accountMenu}
                  onClick={() => setAccountMenu(!accountMenu)}
                >
                  <Avatar person={person} />
                  <span className="account-copy">
                    <strong>{person.name}</strong>
                    <small>{person.email}</small>
                  </span>
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>
          </aside>
          <main className={`main-content ${page === 'Chat' ? 'chat-page' : ''}`}>
            {page !== 'Chat' && (
              <header className="page-top">
                <span>{page}</span>
              </header>
            )}
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
                  {!person.messages.length && (
                    <div className="conversation-heading">
                      <Logo word={false} />
                      <h1>What’s on your mind, {person.name.split(' ')[0]}?</h1>
                    </div>
                  )}
                  {!person.messages.length && (
                    <>
                      {variant === 'C' && !connectedCount && (
                        <div className="assistant-opening">
                          <Button onClick={() => go('Apps')}>
                            <PlugZap size={16} />
                            Connect your apps
                          </Button>
                        </div>
                      )}
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
                      </div>
                    </div>
                    {connectionError && (
                      <div className="error-note" role="alert">
                        {connectionError}
                      </div>
                    )}
                    <div className="service-list">{apps.map((app) => appRow(app))}</div>
                  </>
                )}
                {page === 'Channels' && (
                  <>
                    <div className="page-heading">
                      <Send size={26} />
                      <div>
                        <h1>Channels</h1>
                      </div>
                    </div>
                    <div className="service-row">
                      <AppIcon id="telegram" />
                      <div className="service-copy">
                        <h3>Telegram</h3>
                        <p>
                          {person.telegram === 'none'
                            ? 'Chat with your assistant in Telegram.'
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
                            {person.telegram === 'tested' ? 'Connected' : 'Finish setup'}
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
                    {person.telegram !== 'none' && (
                      <button
                        className="text-button danger"
                        onClick={() => {
                          patch({ telegram: 'none' });
                          notice('Telegram disconnected.');
                        }}
                      >
                        Disconnect Telegram
                      </button>
                    )}
                  </>
                )}
                {page === 'Computer' && developer && (
                  <>
                    <div className="page-heading">
                      <Monitor size={26} />
                      <div>
                        <h1>Computer</h1>
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
                        <p>{computerProvider}</p>
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
                  </>
                )}
                {(page === 'Profile' || page === 'Settings') && (
                  <>
                    <div className="page-heading">
                      <UserRound size={26} />
                      <div>
                        <h1>Settings</h1>
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
                    </div>
                  </>
                )}
              </div>
            )}
          </main>
          {settingsOpen && variant === 'C' && (
            <aside className="settings-drawer" aria-label="Account settings panel">
              <header>
                <h2>Settings</h2>
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
        <Modal
          title="Settings"
          className="settings-dialog"
          close={() => setSettingsOpen(false)}
          returnFocus={() =>
            settingsTrigger.current?.isConnected
              ? settingsTrigger.current
              : (accountAnchor.current?.querySelector<HTMLButtonElement>('.account-button') ??
                navigationButton.current)
          }
          wide
        >
          {settingsPanel}
        </Modal>
      )}
      {modal === 'google' && (
        <Modal title="Choose an account" close={() => setModal(null)}>
          <div className="modal-body">
            <div className="demo-accounts">
              {(['alex', 'sam'] as AccountId[]).map((id) => (
                <button key={id} onClick={() => enter(id)}>
                  <Avatar person={people[id]} />
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
                setAuthError('Sign-in cancelled. Try again.');
              }}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {modal === 'disconnect' && disconnecting && (
        <Modal
          title={`Disconnect ${apps.find((a) => a.id === disconnecting.app)?.name}?`}
          returnFocus={() =>
            document.querySelector<HTMLButtonElement>(`[data-app-id="${disconnecting.app}"] button`)
          }
          close={() => {
            setModal(null);
            setDisconnecting(null);
          }}
        >
          <div className="modal-body">
            <p>
              Disconnect <strong>{disconnecting.connection.identity}</strong>?
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
                  notice('Account disconnected.');
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
                </label>
                <div className="demo-note">
                  <FlaskConical size={17} />
                  <p>A demo token is filled in. Do not enter a real token into this prototype.</p>
                </div>
                <Button primary onClick={() => setTelegramStep('waiting')}>
                  Continue
                  <ArrowRight size={15} />
                </Button>
              </>
            ) : telegramStep === 'waiting' ? (
              <>
                <Link2 size={30} />
                <h3 className="section-heading">Open your bot in Telegram</h3>
                <p>Press Start in Telegram, then return here.</p>
                <div className="pairing-card">
                  <AppIcon id="telegram" />
                  <div>
                    <strong>{telegramHandle}</strong>
                    <small>Pairing link expires in 10 minutes</small>
                  </div>
                </div>
                <div className="plain-note">
                  <Clock3 size={17} />
                  <p>Waiting for you to press Start.</p>
                </div>
                <Button primary onClick={() => setTelegramStep('confirm')}>
                  Open Telegram
                </Button>
              </>
            ) : telegramStep === 'confirm' ? (
              <>
                <ShieldCheck size={30} />
                <h3 className="section-heading">Is this your Telegram account?</h3>
                <div className="pairing-card">
                  <Avatar person={person} />
                  <div>
                    <strong>{telegramIdentity}</strong>
                    <small>Bot: {telegramHandle}</small>
                  </div>
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
                <div className="modal-actions">
                  <Button onClick={() => setModal(null)}>Cancel</Button>
                  <Button primary onClick={() => setTelegramStep('waiting')}>
                    Get a new link
                  </Button>
                </div>
              </>
            ) : telegramStep === 'conflict' ? (
              <>
                <ShieldCheck size={30} />
                <h3 className="section-heading">This bot is already in use</h3>
                <p>Connect a different bot.</p>
                <div className="modal-actions">
                  <Button onClick={() => setModal(null)}>Cancel</Button>
                  <Button primary onClick={() => setTelegramStep('token')}>
                    Use another bot
                  </Button>
                </div>
              </>
            ) : (
              <>
                <CheckCheck size={32} className="success-icon" />
                <h3 className="section-heading">
                  {person.telegram === 'tested' ? 'You’re connected.' : 'Try a conversation.'}
                </h3>
                {person.telegram !== 'tested' && <p>Send “Hello Sidekick” in Telegram.</p>}
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
                {person.telegram === 'tested' ? (
                  <Button primary onClick={() => setModal(null)}>
                    Done
                  </Button>
                ) : (
                  <Button primary onClick={() => patch({ telegram: 'tested' })}>
                    I received a reply
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
                calls. Google photos are represented by fictional avatar fixtures. Provider consent
                and Telegram actions advance the preview only.
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
                    <Button
                      onClick={() => {
                        setDeveloperEnabled(!developer);
                        if (page === 'Computer') go('Chat');
                      }}
                    >
                      {developer ? 'Hide developer tools' : 'Show developer tools'}
                    </Button>
                    <Button onClick={advanceAppSetup}>Advance app setup</Button>
                    <Button onClick={requireReconnect}>App needs reconnection</Button>
                    <Button onClick={deliverSampleEvent}>Deliver sample event</Button>
                    <Button
                      onClick={() => {
                        const app = apps.find(
                          (app) =>
                            !person.apps[app.id]?.some(
                              (connection) => connection.status !== 'attention',
                            ),
                        );
                        if (!app) {
                          notice('All apps are connected.');
                          return;
                        }
                        if (screen !== 'welcome') {
                          setScreen('app');
                          go('Apps');
                        }
                        setConnecting(null);
                        setReconnecting(null);
                        setConnectionError(`${app.name} access declined. Connect to try again.`);
                        setReview(false);
                      }}
                    >
                      Provider denied consent
                    </Button>
                    <Button
                      onClick={() => {
                        setConnecting(null);
                        setReconnecting(null);
                        setConnectionError('');
                        setReview(false);
                        notice('Connection cancelled.');
                      }}
                    >
                      Provider cancelled consent
                    </Button>
                    <Button onClick={() => previewTelegram('expired')}>
                      Telegram pairing expired
                    </Button>
                    <Button onClick={() => previewTelegram('conflict')}>
                      Telegram bot already linked
                    </Button>
                    <Button
                      onClick={() => {
                        setDeveloperEnabled(true);
                        patch({ computer: 'unavailable' });
                        setScreen('app');
                        setPage('Computer');
                        setReview(false);
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
                        setAuthError('Your session expired. Sign in again.');
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
                      developer,
                      computerProvider,
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
