(() => {
  const query = new URLSearchParams(window.location.search);
  const result = query.get('connection');
  const service = /^[a-z]{1,40}$/.test(query.get('service') ?? '') ? query.get('service') : null;
  const connection = ['connected', 'cancelled', 'failed', 'expired'].includes(result)
    ? result
    : 'failed';
  try {
    const channel = new BroadcastChannel('otto.apps');
    channel.postMessage({ connection, service });
    channel.close();
  } catch {}
  window.close();
})();
