export function localeRegion(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new Intl.Locale(value).maximize().region ?? null;
  } catch {
    return null;
  }
}

let timeZoneRegions: Map<string, string> | undefined;

export function timeZoneRegion(value: string) {
  try {
    value = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (!timeZoneRegions) {
    timeZoneRegions = new Map();
    for (let first = 65; first <= 90; first++) {
      for (let second = 65; second <= 90; second++) {
        const locale = new Intl.Locale(
          `und-${String.fromCharCode(first, second)}`,
        ) as Intl.Locale & {
          getTimeZones?: () => string[] | undefined;
          timeZones?: string[];
        };
        if (!locale.getTimeZones && !('timeZones' in locale)) return null;
        const zones = locale.getTimeZones ? locale.getTimeZones() : locale.timeZones;
        for (const zone of zones ?? []) timeZoneRegions.set(zone, locale.region!);
      }
    }
  }
  return timeZoneRegions.get(value) ?? null;
}

export function formattingLocale(region: string | null) {
  const candidate = `en-${region ?? 'GB'}`;
  try {
    if (new Intl.DateTimeFormat(candidate).resolvedOptions().locale === candidate) return candidate;
  } catch {}
  return 'en-GB';
}

export function clockOptions(
  locale: string,
  hourCycle: 'auto' | 'h12' | 'h23',
): Intl.DateTimeFormatOptions {
  const cycle =
    hourCycle === 'auto'
      ? new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
      : hourCycle;
  return {
    hour: cycle === 'h11' || cycle === 'h12' ? 'numeric' : '2-digit',
    minute: '2-digit',
    ...(hourCycle === 'auto' ? {} : { hourCycle }),
  };
}
