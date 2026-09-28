import { randomUUID } from 'node:crypto';
import type { Goal, Message, Schedule, ScheduleRun, Task } from '../src/shared/contracts.ts';

const hour = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const timeZone = 'Europe/Lisbon';

export const fixtureGoals: Goal[] = [
  {
    id: 'a1f0c3de-0000-4000-8000-000000000001',
    title: 'Run a half marathon',
    description: 'Build up to 21 km with three runs each week.',
    progress: 40,
    status: 'active',
    nextAction: 'Plan the long run for Sunday.',
    targetDate: '2026-12-06',
    updatedAt: at(-5 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000002',
    title: 'Read twelve books this year',
    description: 'One book each month, mostly fiction.',
    progress: 75,
    status: 'active',
    nextAction: 'Choose the October book.',
    targetDate: '2026-12-31',
    updatedAt: at(-30 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000003',
    title: 'Learn basic Portuguese grammar',
    description: 'Short lessons on weekday evenings.',
    progress: 20,
    status: 'paused',
    nextAction: 'Review verb tenses.',
    targetDate: null,
    updatedAt: at(-80 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000004',
    title: 'Plan the summer trip',
    description: 'Book flights and a place to stay.',
    progress: 100,
    status: 'completed',
    nextAction: '',
    targetDate: '2026-06-01',
    updatedAt: at(-900 * hour),
  },
];

const briefingMessage = 'b2e1d4ef-0000-4000-8000-000000000011';
const reviewMessage = 'b2e1d4ef-0000-4000-8000-000000000012';

export const fixtureRuns: ScheduleRun[] = [
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000021',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000041',
    scheduledFor: at(-2 * hour),
    timeZone,
    createdAt: at(-2 * hour),
    status: 'succeeded',
    error: null,
    messageId: briefingMessage,
    messageText:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    messagePreview:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30. Rain is likely after 17:00, so plan the run for the…',
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000022',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000042',
    scheduledFor: at(-26 * hour),
    timeZone,
    createdAt: at(-26 * hour),
    status: 'succeeded',
    error: null,
    messageId: reviewMessage,
    messageText:
      'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    messagePreview:
      'Last week you ran 14 km and finished two chapters. Next step for the half marathon goal: plan the long run for Sunday.',
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000023',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000043',
    scheduledFor: at(-50 * hour),
    timeZone,
    createdAt: at(-50 * hour),
    status: 'succeeded',
    error: null,
    messageId: null,
    messagePreview: null,
    messageText: null,
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000024',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000044',
    scheduledFor: at(-74 * hour),
    timeZone,
    createdAt: at(-74 * hour),
    status: 'failed',
    error: 'The task could not finish.',
    messageId: null,
    messagePreview: null,
    messageText: null,
  },
];

export const fixtureSchedules: Schedule[] = [
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    prompt: 'Summarize my calendar, the weather and anything urgent.',
    kind: 'recurring',
    cron: '30 8 * * *',
    runAt: null,
    timeZone,
    enabled: true,
    revision: 0,
    nextRun: at(20 * hour),
    lastRun: fixtureRuns[0],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    prompt: 'Remind me to book the dentist.',
    kind: 'once',
    cron: null,
    runAt: at(50 * hour),
    timeZone,
    enabled: true,
    revision: 1,
    nextRun: at(50 * hour),
    lastRun: fixtureRuns[3],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    prompt: 'Review my goals and suggest one next step for each.',
    kind: 'recurring',
    cron: '0 18 * * 0',
    runAt: null,
    timeZone,
    enabled: false,
    revision: 2,
    nextRun: null,
    lastRun: fixtureRuns[1],
  },
];

const message = (
  id: string,
  role: Message['role'],
  text: string,
  offset: number,
  taskId: string | null = null,
): Message => ({ id, role, text, taskId, createdAt: at(offset), attachments: [] });

export const fixtureMessages: Message[] = [
  message(
    'b2e1d4ef-0000-4000-8000-000000000001',
    'user',
    'Can you check my goals every Sunday evening?',
    -30 * hour,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000002',
    'assistant',
    'Done. I scheduled a weekly review every Sunday at 18:00.',
    -30 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    reviewMessage,
    'assistant',
    'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    -26 * hour,
    'e5b4a7b2-0000-4000-8000-000000000042',
  ),
  ...Array.from({ length: 8 }, (_, index) =>
    message(
      `b2e1d4ef-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      index % 2 ? 'assistant' : 'user',
      index % 2
        ? 'Here is a short answer with the details you asked for. I kept it brief so you can scan it quickly.'
        : 'One more question about my plans for this week.',
      -20 * hour + index * 20 * 60_000,
      'e5b4a7b2-0000-4000-8000-000000000052',
    ),
  ),
  message(
    briefingMessage,
    'assistant',
    'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    -2 * hour,
    'e5b4a7b2-0000-4000-8000-000000000041',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000003',
    'user',
    'Thanks. Move the call with Sam to 16:00.',
    -1 * hour,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000004',
    'assistant',
    'The call with Sam is now at 16:00.',
    -1 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
];

const days: Record<string, string> = {
  weekdays: '1-5',
  weekends: '0,6',
  'every day': '*',
  daily: '*',
};

export function createPlansFixture() {
  const goals: Goal[] = structuredClone(fixtureGoals);
  const schedules: Schedule[] = structuredClone(fixtureSchedules);
  const messages: Message[] = structuredClone(fixtureMessages);
  const tasks: Task[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  function reply(text: string) {
    const lower = text.toLowerCase();
    const schedule = schedules.find((item) => text.includes(`"${item.title}"`));
    const goal = goals.find((item) => text.includes(`"${item.title}"`));
    const time = /(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?/i.exec(text);
    if (schedule) {
      const [minute, hour, , , day] = (schedule.cron ?? '0 9 * * *').split(' ');
      const nextDay = Object.entries(days).find(([word]) => lower.includes(word))?.[1] ?? day;
      const nextHour = time
        ? String(
            (Number(time[1]) % 12) + (time[3]?.toLowerCase() === 'pm' ? 12 : 0) || Number(time[1]),
          )
        : hour;
      const nextMinute = time ? String(Number(time[2] ?? 0)) : minute;
      if (lower.includes('pause')) schedule.enabled = false;
      else if (lower.includes('resume')) schedule.enabled = true;
      else if (schedule.kind === 'recurring')
        schedule.cron = `${nextMinute} ${nextHour} * * ${nextDay}`;
      schedule.revision += 1;
      return schedule.enabled
        ? `Done. ${schedule.title} now runs at ${nextHour.padStart(2, '0')}:${nextMinute.padStart(2, '0')}${nextDay === '1-5' ? ' on weekdays' : ''}.`
        : `Done. I paused ${schedule.title}.`;
    }
    if (goal) {
      const percent = /(\d{1,3})\s*%/.exec(text);
      if (percent) goal.progress = Math.min(100, Number(percent[1]));
      if (lower.includes('pause')) goal.status = 'paused';
      if (lower.includes('done') || lower.includes('complete')) goal.status = 'completed';
      const next = /next step[^:]*:\s*(.+)$/i.exec(text);
      if (next) goal.nextAction = next[1].trim();
      goal.updatedAt = new Date().toISOString();
      return `Done. I updated ${goal.title}${percent ? ` to ${goal.progress}%` : ''}.`;
    }
    if (lower.startsWith('new goal')) {
      const title = text.replace(/^new goal:\s*/i, '').slice(0, 80) || 'New goal';
      goals.unshift({
        ...fixtureGoals[0],
        id: randomUUID(),
        title,
        description: '',
        progress: 0,
        nextAction: 'Choose the first step.',
        targetDate: null,
      });
      return `Done. I added the goal ${title}.`;
    }
    if (lower.startsWith('new schedule')) {
      const title = text.replace(/^new schedule:\s*/i, '').slice(0, 80) || 'New schedule';
      schedules.unshift({
        ...fixtureSchedules[0],
        id: randomUUID(),
        title,
        prompt: title,
        lastRun: null,
      });
      return `Done. I scheduled ${title} every day at 08:30.`;
    }
    return 'I noted that. Tell me what to change and I will do it.';
  }
  async function handle(request: Request, url: URL): Promise<Response | null> {
    const patch = /^\/api\/(goals|schedules)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET') {
      if (url.pathname === '/api/goals') return Response.json(goals);
      if (url.pathname === '/api/schedules') return Response.json(schedules);
      if (url.pathname === '/api/schedule-runs')
        return Response.json({ runs: fixtureRuns, nextCursor: null });
      if (url.pathname === '/api/messages') return Response.json([]);
      return null;
    }
    if (request.method === 'PATCH' && patch) {
      const list: Array<Goal | Schedule> = patch[1] === 'goals' ? goals : schedules;
      const item = list.find((entry) => entry.id === patch[2]);
      if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
      Object.assign(item, await request.json());
      if ('enabled' in item) {
        item.revision += 1;
        item.nextRun = item.enabled ? new Date(Date.now() + 20 * hour).toISOString() : null;
      }
      changed();
      return Response.json(item);
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await request.json()) as { text: string; clientMessageId?: string };
      const taskId = randomUUID();
      const messageId = body.clientMessageId ?? randomUUID();
      const now = new Date().toISOString();
      messages.push({
        id: messageId,
        role: 'user',
        text: body.text,
        taskId,
        createdAt: now,
        attachments: [],
      });
      tasks.unshift({
        id: taskId,
        title: body.text.slice(0, 100),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        showTyping: true,
      });
      changed();
      setTimeout(() => {
        const answer = reply(body.text);
        const done = new Date().toISOString();
        messages.push({
          id: randomUUID(),
          role: 'assistant',
          text: answer,
          taskId,
          createdAt: done,
          attachments: [],
        });
        Object.assign(tasks[tasks.findIndex((task) => task.id === taskId)], {
          status: 'succeeded',
          updatedAt: done,
          showTyping: false,
        });
        changed();
      }, 1800);
      return Response.json({ taskId, messageId, continued: false });
    }
    return null;
  }
  function reset() {
    goals.splice(0, goals.length, ...structuredClone(fixtureGoals));
    schedules.splice(0, schedules.length, ...structuredClone(fixtureSchedules));
    messages.splice(0, messages.length, ...structuredClone(fixtureMessages));
    tasks.splice(0, tasks.length);
    changed();
  }
  return {
    reset,
    handle,
    state: () => ({ messages, tasks }),
    listen(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
