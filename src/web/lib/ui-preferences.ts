type UiPreference = 'sidekick.sidebar' | 'sidekick.inspector' | 'sidekick.inspector.width';

export function readUiPreference(key: UiPreference) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeUiPreference(key: UiPreference, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}
