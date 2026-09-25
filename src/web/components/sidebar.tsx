import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Sun,
} from 'lucide-react';
import { BrandMark } from './brand';
import { ConnectionMenu } from './connection-menu';
import { currentTheme, setTheme, subscribeTheme } from '../lib/theme';
import {
  isEditingTarget,
  navigationItems,
  navigationShortcut,
  shortcutLabel,
} from '../lib/navigation';

export function Sidebar({
  path,
  collapsed,
  onToggle,
  onNavigate,
  onRestart,
  inspectorEnabled = false,
  inspectorOpen = false,
  onToggleInspector,
}: {
  path: string;
  collapsed: boolean;
  onToggle(): void;
  onNavigate(path: string): void;
  onRestart(): void;
  inspectorEnabled?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?(): void;
}) {
  const [hints, setHints] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(false);
    };
    const down = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.composedPath().some(isEditingTarget) ||
        isEditingTarget(document.activeElement)
      ) {
        clear();
        return;
      }
      if (event.key === (mac ? 'Meta' : 'Control')) {
        if (!event.repeat && !timer)
          timer = setTimeout(() => {
            if (!isEditingTarget(document.activeElement)) setHints(true);
          }, 650);
        return;
      }
      clear();
      const action = navigationShortcut(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      navigate.current(action.path);
      requestAnimationFrame(() => {
        const target =
          action.path === '/'
            ? document.querySelector<HTMLElement>('.composer-editor[contenteditable="true"]')
            : document.getElementById('workspace');
        target?.focus();
      });
    };
    const up = (event: KeyboardEvent) => {
      if (!(mac ? event.metaKey : event.ctrlKey)) clear();
    };
    const focus = () => {
      if (isEditingTarget(document.activeElement)) clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('focusin', focus);
    document.addEventListener('visibilitychange', clear);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [mac]);
  return (
    <aside className={`sidebar ${hints ? 'show-shortcuts' : ''}`} aria-label="Sidebar">
      <a
        href="/"
        className="brand"
        aria-label="Sidekick"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onNavigate('/');
        }}
      >
        <BrandMark />
        <span>sidekick</span>
      </a>
      <nav className="main-nav" aria-label="Main navigation" id="sidebar-navigation">
        <ul
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const links = Array.from(event.currentTarget.querySelectorAll('a'));
            const index = links.indexOf(document.activeElement as HTMLAnchorElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? links.length - 1
                  : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                    ? (index + 1) % links.length
                    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                      ? (index - 1 + links.length) % links.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            links[next]?.focus();
          }}
        >
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const label = item.key ? shortcutLabel(item.key, mac) : undefined;
            return (
              <li key={item.path}>
                <a
                  href={item.path}
                  aria-label={item.label}
                  aria-current={path === item.path ? 'page' : undefined}
                  aria-keyshortcuts={
                    item.key
                      ? `Meta+${item.key.toUpperCase()} Control+${item.key.toUpperCase()}`
                      : undefined
                  }
                  title={label ? `${item.label} (${label})` : item.label}
                  className={`nav-link ${path === item.path ? 'nav-link-active' : ''}`}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    )
                      return;
                    event.preventDefault();
                    onNavigate(item.path);
                  }}
                >
                  <Icon size={26} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-label">{item.label}</span>
                  {item.key && (
                    <kbd className="nav-shortcut" aria-hidden="true">
                      {item.key.toUpperCase()}
                    </kbd>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mobile-navigation-more">
        <ConnectionMenu
          label="More navigation"
          trigger={
            <>
              <MoreHorizontal size={20} aria-hidden="true" />
              <span>More</span>
            </>
          }
        >
          {(close) => (
            <>
              {inspectorEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onToggleInspector?.();
                  }}
                >
                  <Monitor size={18} aria-hidden="true" /> Inspector
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onRestart();
                }}
              >
                <RotateCcw size={18} aria-hidden="true" /> Get started
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  toggleTheme();
                  close();
                }}
              >
                <ThemeIcon size={18} aria-hidden="true" /> {themeLabel}
              </button>
            </>
          )}
        </ConnectionMenu>
      </div>
      <div className="sidebar-bottom">
        <button
          type="button"
          className="nav-link theme-toggle"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={toggleTheme}
        >
          <ThemeIcon size={22} aria-hidden="true" />
          <span className="nav-label">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
        </button>
        {inspectorEnabled && (
          <button
            type="button"
            className={`nav-link ${inspectorOpen ? 'nav-link-active' : ''}`}
            aria-label="Inspector"
            aria-expanded={inspectorOpen}
            aria-controls="developer-inspector"
            title="Inspector"
            onClick={onToggleInspector}
          >
            <Monitor size={22} aria-hidden="true" />
            <span className="nav-label">Inspector</span>
          </button>
        )}
        <button
          type="button"
          className="nav-link"
          aria-label="Get started"
          title="Get started"
          onClick={onRestart}
        >
          <RotateCcw size={22} aria-hidden="true" />
          <span className="nav-label">Get started</span>
        </button>
        <button
          type="button"
          className="nav-link sidebar-toggle"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="sidebar-navigation"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggle}
        >
          {collapsed ? (
            <PanelLeftOpen size={22} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={22} aria-hidden="true" />
          )}
          <span className="nav-label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
