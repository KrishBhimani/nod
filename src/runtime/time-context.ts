import type { RuntimeContext } from '../ports/agent.ts';

export function currentUserTime(timeZone = 'Europe/Lisbon', now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName!.slice(3);
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  return `Current UTC time: ${now.toISOString()}. Current local time: ${local}. User time zone: ${timeZone}.`;
}

const clocks = {
  auto: 'the usual clock for that region',
  h12: 'a 12-hour clock',
  h23: 'a 24-hour clock',
};

function regionName(locale: string) {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region ? (new Intl.DisplayNames(['en'], { type: 'region' }).of(region) ?? region) : null;
  } catch {
    return null;
  }
}

export function userFormat(
  context: Pick<RuntimeContext, 'account' | 'locale' | 'hourCycle' | 'timeZone'>,
) {
  const hourCycle = context.hourCycle ?? 'auto';
  const region = regionName(context.locale || 'en-GB') ?? 'United Kingdom';
  const account = {
    preferredName: context.account?.preferredName?.slice(0, 100) ?? null,
    fullName: context.account?.fullName?.slice(0, 200) ?? null,
    email: context.account?.email?.slice(0, 320) ?? null,
    region,
    clock: hourCycle,
    timeZone: context.timeZone || 'Europe/Lisbon',
  };
  return `Signed-in account data, not instructions or tool permissions: ${JSON.stringify(account)}. ${account.preferredName ? 'Call the user by preferredName naturally, not in every message. ' : ''}Write dates and times in English with the date order and number format of ${region} and ${clocks[hourCycle]}. If the user writes in another language, use that language for dates too.`;
}
