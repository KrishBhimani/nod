import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarClock,
  KeyRound,
  Link2,
  MessageCircle,
  Monitor,
  Radio,
  RotateCcw,
  Target,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { Chat } from './pages/chat';
import { Vault } from './pages/vault';
import { Connections } from './pages/connections';
import { Channels } from './pages/channels';
import { Credentials } from './pages/credentials';
import { Inspector } from './pages/inspector';
import { Plans } from './pages/plans';
import { ApprovalPage } from './pages/approval';
import { useAppState } from './hooks/use-app-state';
import { Button, Loading, Notice } from './components/ui';
import { BrandMark } from './components/brand';

function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function Link({
  href,
  children,
  className,
  current,
  label,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  current?: boolean;
  label?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
function Workspace({ path }: { path: string }) {
  const { state, streams, error, connected, refresh } = useAppState();
  const [inspector, setInspector] = useState(
    () => path === '/dev' || localStorage.getItem('sidekick.inspector') === 'open',
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidekick.sidebar') === 'collapsed',
  );
  const [onboarding, setOnboarding] = useState(0);
  const navigation = [
    { path: '/', label: 'Chat', icon: MessageCircle },
    { path: '/goals', label: 'Goals', icon: Target },
    { path: '/schedule', label: 'Schedule', icon: CalendarClock },
    { path: '/connections', label: 'Connections', icon: Link2 },
    { path: '/channels', label: 'Channels', icon: Radio },
    { path: '/vault', label: 'Vault', icon: KeyRound },
  ];
  const currentPath = path === '/dev' || path === '/you' ? '/' : path;
  useEffect(() => {
    if (path === '/dev') setInspector(true);
  }, [path]);
  useEffect(() => {
    localStorage.setItem('sidekick.inspector', inspector ? 'open' : 'closed');
  }, [inspector]);
  useEffect(() => {
    localStorage.setItem('sidekick.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${inspector ? 'with-inspector' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand" label="Sidekick">
          <BrandMark />
          <span>sidekick</span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              label={item.label}
              current={currentPath === item.path}
              className={`nav-link ${currentPath === item.path ? 'nav-link-active' : ''}`}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-link"
            aria-label="Restart setup"
            onClick={() => {
              setOnboarding((value) => value + 1);
              navigate('/');
            }}
          >
            <RotateCcw size={17} />
            <span>Get started</span>
          </button>
          <button
            className="nav-link sidebar-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            <span>Collapse</span>
          </button>
        </div>
      </aside>
      <div className="workspace-frame">
        <header className="workspace-header">
          <span className="workspace-title">
            {navigation.find((item) => item.path === currentPath)?.label ?? 'Chat'}
          </span>
          <div className="workspace-header-actions">
            {!connected && <span className="reconnecting">Reconnecting…</span>}
            {state?.configuration.inspectorEnabled && (
              <Button
                variant={inspector ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setInspector(!inspector)}
                aria-pressed={inspector}
              >
                <Monitor size={16} />
                <span>Inspector</span>
              </Button>
            )}
          </div>
        </header>
        <div className="workspace-body">
          <main id="workspace" className="main-workspace">
            {!state ? (
              <div className="initial-loading">
                {error ? (
                  <>
                    <Notice>{error}</Notice>
                    <Button variant="outline" onClick={() => void refresh()}>
                      Try again
                    </Button>
                  </>
                ) : (
                  <Loading label="Opening Sidekick…" />
                )}
              </div>
            ) : (
              <>
                <div className="chat-route" hidden={currentPath !== '/'}>
                  <Chat
                    state={state}
                    streams={streams}
                    refresh={refresh}
                    onboarding={onboarding}
                    onOnboarded={() => setOnboarding(0)}
                  />
                </div>
                {currentPath === '/vault' && <Vault />}
                {currentPath === '/connections' && <Connections />}
                {currentPath === '/channels' && <Channels />}
                {currentPath === '/goals' && <Plans key="goals" type="goals" />}
                {currentPath === '/schedule' && <Plans key="schedules" type="schedules" />}
                {!navigation.some((item) => item.path === currentPath) && (
                  <div className="empty-state">
                    <h1>This page isn’t here.</h1>
                    <Button variant="outline" onClick={() => navigate('/')}>
                      <ArrowLeft size={16} />
                      Back to chat
                    </Button>
                  </div>
                )}
              </>
            )}
            {state && error && (
              <div className="connection-notice">
                <Notice>{error}</Notice>
              </div>
            )}
          </main>
          {state?.configuration.inspectorEnabled && inspector && (
            <Inspector onClose={() => setInspector(false)} />
          )}
        </div>
      </div>
    </div>
  );
}
export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const match = /^\/credentials\/([^/]+)\/?$/.exec(path);
  if (match) return <Credentials key={match[1]} id={match[1]} />;
  const approval = /^\/approvals\/([^/]+)\/?$/.exec(path);
  if (approval) return <ApprovalPage key={approval[1]} id={approval[1]} />;
  return <Workspace path={path} />;
}
