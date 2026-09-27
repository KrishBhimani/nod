import { setTimeout as sleep } from 'node:timers/promises';

export async function verifyDeployment({
  origin,
  release,
  fetcher = fetch,
  attempts = 60,
  intervalMs = 5000,
  wait = sleep,
}) {
  const request = async (path, init = {}) =>
    fetcher(new URL(path, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      ...init,
    });
  let healthy = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const health = await request('/api/health');
      const body = health.ok ? await health.json() : undefined;
      healthy = body?.ok === true && body.release === release;
    } catch {}
    if (healthy) break;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  if (!healthy) throw new Error('The new gateway release did not become healthy.');
  const session = await request('/api/session');
  const account = session.ok ? await session.json() : undefined;
  if (
    account?.user !== null ||
    account?.settings !== null ||
    account?.auth?.mode !== 'google' ||
    account?.auth?.googleAvailable !== true ||
    account?.capabilities?.developer !== false
  )
    throw new Error('The public session boundary did not pass verification.');
  const checks = [
    [
      '/api/state',
      { headers: { 'x-sidekick-owner': '00000000-0000-4000-8000-000000000001' } },
      401,
    ],
    ['/api/internal/channels/claim', { method: 'POST' }, 404],
    ['/runtime/start', { method: 'POST' }, 404],
    ['/api/login', { method: 'POST', headers: { origin: 'https://foreign.example' } }, 403],
  ];
  for (const [path, init, status] of checks) {
    const response = await request(path, init);
    await response.body?.cancel();
    if (response.status !== status)
      throw new Error('A public authorization boundary did not pass verification.');
  }
}
