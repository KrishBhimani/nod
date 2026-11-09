import { useEffect, useState } from 'react';
import { IntegrationCard } from './integration-card';
import { Tooltip } from './tooltip';
import { Folder, Plus, X } from './icons';
import { Button, Input, Notice } from './ui';
import { api, errorMessage } from '../lib/api';
import { desktopFolderPicker } from '../lib/desktop';

type Folders = { folders: string[] };

export function LocalFilesCard() {
  const [folders, setFolders] = useState<string[]>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = desktopFolderPicker();

  useEffect(() => {
    api<Folders>('/api/local-files')
      .then((result) => setFolders(result.folders))
      .catch((failure) => setError(errorMessage(failure)));
  }, []);

  async function change(method: 'POST' | 'DELETE', value: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api<Folders>('/api/local-files', {
        method,
        body: JSON.stringify({ path: value }),
      });
      setFolders(result.folders);
      setPath('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!picker) return change('POST', path);
    const chosen = await picker().catch((failure) => {
      setError(errorMessage(failure));
      return null;
    });
    if (chosen) await change('POST', chosen);
  }

  return (
    <>
      <IntegrationCard
        id="local-files"
        name="Local files"
        logo={<Folder aria-hidden="true" />}
        description={
          folders?.length
            ? 'Nod can list, read, write, edit, move and trash files in these folders.'
            : 'Share folders on this computer, such as Downloads, so Nod can tidy them.'
        }
        detail={folders?.map((folder) => (
          <div key={folder} className="local-files-folder">
            <Tooltip content={folder}>
              <span>{folder}</span>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop sharing ${folder}`}
              disabled={busy}
              onClick={() => void change('DELETE', folder)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>
        ))}
        actions={
          <>
            {!picker && (
              <Input
                aria-label="Folder path"
                placeholder="/Users/you/Downloads"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (!picker && !path.trim())}
              onClick={() => void add()}
            >
              <Plus size={16} aria-hidden="true" />
              Add folder
            </Button>
          </>
        }
      />
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
    </>
  );
}
