export type Theme = 'light' | 'dark';

const storageKey = 'sidekick.theme';
const changeEvent = 'sidekick:theme';
let chosenTheme: Theme | undefined;

function savedTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#18171c' : '#fefdfc');
  window.dispatchEvent(new Event(changeEvent));
}

export function setTheme(theme: Theme) {
  chosenTheme = theme;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {}
  applyTheme(theme);
}

export function subscribeTheme(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  return () => window.removeEventListener(changeEvent, listener);
}

export function initializeTheme() {
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  const update = () => applyTheme(chosenTheme ?? (system?.matches ? 'dark' : 'light'));
  chosenTheme = savedTheme();
  update();
  const storage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    chosenTheme = savedTheme();
    update();
  };
  system?.addEventListener('change', update);
  window.addEventListener('storage', storage);
  return () => {
    system?.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
