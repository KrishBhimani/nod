import type { InspectorObservationsResponse, ToolCall } from '../../shared/inspector';

export type ToolStatusFilter = 'all' | ToolCall['status'];

export function formatInspectorJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? 'Not recorded';
}

export function formatModelCost(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Price unavailable';
  if (value > 0 && value < 0.000001) return '< USD 0.000001';
  return `USD ${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

export function formatToolDuration(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Not recorded';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function filterToolCalls(calls: ToolCall[], query: string, status: ToolStatusFilter) {
  const search = query.trim().toLocaleLowerCase();
  return calls.filter(
    (call) =>
      (status === 'all' || call.status === status) &&
      (!search ||
        [
          call.name,
          call.error ?? '',
          formatInspectorJson(call.input),
          formatInspectorJson(call.output),
        ].some((value) => value.toLocaleLowerCase().includes(search))),
  );
}

export function mergeObservationPage(
  current: InspectorObservationsResponse,
  page: InspectorObservationsResponse,
  kind: 'older' | 'refresh',
): InspectorObservationsResponse {
  const calls =
    kind === 'refresh' ? [...current.calls, ...page.calls] : [...page.calls, ...current.calls];
  const usage =
    kind === 'refresh' ? [...current.usage, ...page.usage] : [...page.usage, ...current.usage];
  const cursor = kind === 'older' ? page : current;
  return {
    calls: [...new Map(calls.map((call) => [call.id, call])).values()].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    ),
    usage: [...new Map(usage.map((request) => [request.id, request])).values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
    summary: kind === 'refresh' ? page.summary : current.summary,
    hasOlder: cursor.hasOlder,
    nextBefore: cursor.nextBefore,
    nextBeforeId: cursor.nextBeforeId,
  };
}

export async function completeObservationRefresh(
  current: InspectorObservationsResponse,
  newest: InspectorObservationsResponse,
  load: (cursor: { before: string; beforeId?: string }) => Promise<InspectorObservationsResponse>,
  signal: AbortSignal,
): Promise<{ data: InspectorObservationsResponse; reset: boolean }> {
  signal.throwIfAborted();
  if (
    newest.summary.calls < current.summary.calls ||
    newest.summary.modelRequests < current.summary.modelRequests
  )
    return { data: newest, reset: true };
  const known = new Set([...current.calls, ...current.usage].map((row) => row.id));
  if (!known.size) return { data: newest, reset: true };
  const running = new Set(
    current.calls.filter((call) => call.status === 'running').map((call) => call.id),
  );
  let combined = newest;
  let page = newest;
  const visited = new Set<string>();
  let overlaps = false;
  while (true) {
    overlaps ||= [...page.calls, ...page.usage].some((row) => known.has(row.id));
    for (const call of page.calls) running.delete(call.id);
    if (overlaps && !running.size) break;
    if (!page.hasOlder) return { data: newest, reset: true };
    if (!page.nextBefore)
      throw new Error('The recording page is incomplete. Refreshing will retry.');
    const cursor = JSON.stringify([page.nextBefore, page.nextBeforeId]);
    if (visited.has(cursor))
      throw new Error('The recording cursor did not advance. Refreshing will retry.');
    visited.add(cursor);
    page = await load({ before: page.nextBefore, beforeId: page.nextBeforeId });
    signal.throwIfAborted();
    combined = mergeObservationPage(combined, page, 'older');
  }
  return { data: mergeObservationPage(current, combined, 'refresh'), reset: false };
}
