import type { AccountPreferences } from '../../shared/account';
import { api } from './api';
import { browserLocale, setDateFormat } from './date-format';
import { pageDataCache } from './page-data-cache';

let writes: Promise<unknown> = Promise.resolve();
let browserLocaleSave: Promise<void> | undefined;

export function savePreferences(change: Partial<AccountPreferences>, signal?: AbortSignal) {
  const write = writes
    .catch(() => {})
    .then(async () => {
      const saved = await api<AccountPreferences>('/api/preferences', {
        method: 'PATCH',
        signal,
        body: JSON.stringify(change),
      });
      setDateFormat(saved);
      pageDataCache.update<AccountPreferences>('/api/preferences', () => saved);
      return saved;
    });
  writes = write;
  return write;
}

export function saveBrowserLocale() {
  browserLocaleSave ??= savePreferences({ locale: browserLocale() })
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      browserLocaleSave = undefined;
    });
}
