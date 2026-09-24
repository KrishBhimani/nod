import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Code2,
  KeyRound,
  Link2,
  MessageCircle,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { Chat } from './pages/chat';
import { Vault } from './pages/vault';
import { Connections } from './pages/connections';
import { Credentials } from './pages/credentials';
import { Inspector } from './pages/inspector';
import { You } from './pages/you';
import { ApprovalPage } from './pages/approval';
import { useAppState } from './hooks/use-app-state';
import { Button, Loading, Notice } from './components/ui';

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
  const navigation = [
    { path: '/', label: 'Conversation', icon: MessageCircle },
    { path: '/vault', label: 'Vault', icon: KeyRound },
    { path: '/connections', label: 'Connections', icon: Link2 },
    { path: '/you', label: 'You', icon: UserRound },
  ];
  return (
    <div className="app-shell">
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Sparkles size={19} strokeWidth={1.8} />
          </span>
          <span>Sidekick</span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              label={item.label}
              current={path === item.path}
              className={`nav-link ${path === item.path ? 'nav-link-active' : ''}`}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {state?.configuration.inspectorEnabled && (
            <Link
              href="/dev"
              label="Inspector"
              current={path === '/dev'}
              className={`nav-link inspector-link ${path === '/dev' ? 'nav-link-active' : ''}`}
            >
              <Code2 size={17} />
              <span>Inspector</span>
            </Link>
          )}
          <div className="workspace-label">
            <span className={`connection-dot ${connected ? 'connected' : ''}`} />
            <span>{connected ? 'Local workspace' : 'Reconnecting…'}</span>
          </div>
        </div>
      </aside>
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
              <Loading label="Opening your workspace…" />
            )}
          </div>
        ) : path === '/' ? (
          <Chat state={state} streams={streams} refresh={refresh} />
        ) : path === '/vault' ? (
          <Vault />
        ) : path === '/connections' ? (
          <Connections />
        ) : path === '/you' ? (
          <You />
        ) : path === '/dev' ? (
          <Inspector />
        ) : (
          <div className="empty-state">
            <h1>This page isn’t here.</h1>
            <Button variant="outline" onClick={() => navigate('/')}>
              <ArrowLeft size={16} />
              Back to the conversation
            </Button>
          </div>
        )}
        {state && error && (
          <div className="connection-notice">
            <Notice>{error}</Notice>
          </div>
        )}
      </main>
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
