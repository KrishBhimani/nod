export type ScheduleFrequency = 'daily' | 'weekly' | 'custom';
export const weekDays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function readSchedule(cron: string) {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7])$/.exec(cron.trim());
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    return { frequency: 'custom' as ScheduleFrequency, time: '09:00', day: '1' };
  return {
    frequency: (match[3] === '*' ? 'daily' : 'weekly') as ScheduleFrequency,
    time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`,
    day: String(Number(match[3]) % 7 || 0),
  };
}

export function scheduleExpression(
  frequency: ScheduleFrequency,
  time: string,
  day: string,
  original?: string,
) {
  if (frequency === 'custom' && original) return original;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error('Choose a valid time.');
  if (frequency === 'weekly' && !/^[0-6]$/.test(day)) throw new Error('Choose a day of the week.');
  return `${Number(match[2])} ${Number(match[1])} * * ${frequency === 'weekly' ? day : '*'}`;
}

export function scheduleLabel(cron: string) {
  const value = readSchedule(cron);
  if (value.frequency === 'custom') return 'Custom timing';
  return `${value.frequency === 'daily' ? 'Every day' : `Every ${weekDays[Number(value.day)]}`} at ${value.time}`;
}
