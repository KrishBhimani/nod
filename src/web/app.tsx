import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Chat } from './pages/chat';
import { Vault } from './pages/vault';
import { Apps } from './pages/apps';
import { Channels } from './pages/channels';
import { Credentials } from './pages/credentials';
import { Inspector } from './pages/inspector';
import { Goals } from './pages/goals';
import { SchedulePage } from './pages/schedule';
import { useAppState } from './hooks/use-app-state';
import { Button, Loading, Notice } from './components/ui';
import { Sidebar } from './components/sidebar';
import { navigationItems } from './lib/navigation';
import { BrowserWindow } from './pages/browser';

function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function Workspace({ path }: { path: string }) {
  const { state, streams, error, connected, refresh, resetConversation } = useAppState();
  const [inspector, setInspector] = useState(
    () =>
      path === '/dev' ||
      (window.innerWidth > 720 && localStorage.getItem('sidekick.inspector') === 'open'),
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidekick.sidebar') === 'collapsed',
  );
  const [composerDraft, setComposerDraft] = useState<{ text: string; nonce: number }>();
  const [inspectionFocus, setInspectionFocus] = useState<{ messageId: string; taskId: string }>();
  useEffect(() => {
    const compose = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      if (!detail?.text) return;
      setComposerDraft({ text: detail.text, nonce: Date.now() });
      navigate('/');
    };
    const inspect = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId: string; taskId: string }>).detail;
      if (!detail?.taskId) return;
      setInspectionFocus(detail);
      setInspector(true);
    };
    window.addEventListener('sidekick:compose', compose);
    window.addEventListener('sidekick:inspect-message', inspect);
    return () => {
      window.removeEventListener('sidekick:compose', compose);
      window.removeEventListener('sidekick:inspect-message', inspect);
    };
  }, []);
  const currentPath = path === '/dev' || path === '/you' ? '/' : path;
  useEffect(() => {
    if (path === '/dev') setInspector(true);
  }, [path]);
  useEffect(() => {
    const closeOnNavigation = () => {
      if (window.innerWidth <= 720 && window.location.pathname !== '/dev') setInspector(false);
    };
    window.addEventListener('popstate', closeOnNavigation);
    return () => window.removeEventListener('popstate', closeOnNavigation);
  }, []);
  useEffect(() => {
    localStorage.setItem('sidekick.inspector', inspector ? 'open' : 'closed');
  }, [inspector]);
  useEffect(() => {
    localStorage.setItem('sidekick.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);
  const inspectorOpen = !!state?.configuration.inspectorEnabled && inspector;
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${inspectorOpen ? 'with-inspector' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      <Sidebar
        path={currentPath}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        inspectorEnabled={state?.configuration.inspectorEnabled}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspector((value) => !value)}
        onNavigate={navigate}
        onRestart={() => {
          navigate('/');
          setComposerDraft(undefined);
          setInspectionFocus(undefined);
          window.dispatchEvent(new CustomEvent('sidekick:restart-setup'));
        }}
      />
      <div className="workspace-frame">
        <div className="workspace-body">
          <main id="workspace" className="main-workspace" tabIndex={-1}>
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
                    resetConversation={resetConversation}
                    composerDraft={composerDraft}
                  />
                </div>
                {currentPath === '/vault' && <Vault />}
                {currentPath === '/apps' && <Apps />}
                {currentPath === '/channels' && <Channels />}
                {currentPath === '/goals' && <Goals />}
                {currentPath === '/schedule' && <SchedulePage />}
                {!navigationItems.some((item) => item.path === currentPath) && (
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
            {state && (error || !connected) && (
              <div className="connection-notice">
                <Notice kind={error ? 'error' : 'info'}>{error || 'Reconnecting…'}</Notice>
              </div>
            )}
          </main>
          {inspectorOpen && (
            <Inspector focus={inspectionFocus} onClose={() => setInspector(false)} />
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
  if (path === '/browser') return <BrowserWindow />;
  const match = /^\/(?:vault|credentials)\/([^/]+)\/?$/.exec(path);
  if (match) return <Credentials key={match[1]} id={match[1]} />;
  return <Workspace path={path} />;
}
