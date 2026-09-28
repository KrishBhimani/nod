(() => {
  const result = new URLSearchParams(window.location.search).get('connection');
  const connection = ['connected', 'cancelled', 'failed', 'expired'].includes(result)
    ? result
    : 'failed';
  try {
    const channel = new BroadcastChannel('otto.apps');
    channel.postMessage({ connection });
    channel.close();
  } catch {}
  window.close();
})();
