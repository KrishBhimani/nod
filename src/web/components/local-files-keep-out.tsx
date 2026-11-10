import { useState } from 'react';
import { X } from './icons';
import { Button, Notice } from './ui';
import { api, errorMessage } from '../lib/api';
import { usePageData } from '../hooks/use-page-data';

type KeepOut = { available: boolean; paths: string[] };
const path = '/api/local-files/keep-out';

export function LocalFilesKeepOut() {
  const { data, update } = usePageData<KeepOut>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!data?.available || !data.paths.length) return null;

  async function letIn(folder: string) {
    setBusy(true);
    setError('');
    try {
      const saved = await api<KeepOut>(path, {
        method: 'DELETE',
        body: JSON.stringify({ path: folder }),
      });
      update(() => saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-region">
      <div className="account-preference-row">
        <span>Kept out of local files</span>
      </div>
      <p className="field-hint">
        Nod never opens or changes anything in these folders. Tell Nod to add one; only you can
        remove it here.
      </p>
      {data.paths.map((folder) => (
        <div key={folder} className="account-preference-row">
          <span className="local-files-keep-out">{folder}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Let Nod into ${folder} again`}
            disabled={busy}
            onClick={() => void letIn(folder)}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
    </section>
  );
}
