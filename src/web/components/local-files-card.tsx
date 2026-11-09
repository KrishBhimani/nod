import { useState } from 'react';
import { IntegrationCard } from './integration-card';
import { Tooltip } from './tooltip';
import { Folder, Plus, X } from './icons';
import { Button, Input, Notice, Switch } from './ui';
import { api, errorMessage } from '../lib/api';
import { desktopFolderPicker } from '../lib/desktop';

type LocalFolder = { path: string; readOnly: boolean };
export type LocalFilesState = { available: boolean; folders: LocalFolder[] };

export function LocalFilesCard({
  state,
  onChange,
}: {
  state: LocalFilesState;
  onChange(state: LocalFilesState): void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = desktopFolderPicker();

  async function change(method: 'POST' | 'DELETE', value: string, readOnly?: boolean) {
    setBusy(true);
    setError('');
    try {
      onChange(
        await api<LocalFilesState>('/api/local-files', {
          method,
          body: JSON.stringify({ path: value, ...(readOnly === undefined ? {} : { readOnly }) }),
        }),
      );
      if (method === 'POST' && readOnly === undefined) setPath('');
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

  const folders = state.folders;

  return (
    <>
      <IntegrationCard
        id="local-files"
        name="Local files"
        logo={<Folder aria-hidden="true" />}
        description={
          folders.length
            ? 'Nod can work with files in these folders on the computer it runs on. Read-only folders can be listed and read, not changed.'
            : 'Share folders on the computer Nod runs on, such as Downloads, so Nod can tidy them.'
        }
        detail={folders.map((folder) => (
          <div key={folder.path} className="local-files-folder">
            <Tooltip content={folder.path}>
              <span>{folder.path}</span>
            </Tooltip>
            <label className="local-files-read-only">
              Read-only
              <Switch
                checked={folder.readOnly}
                disabled={busy}
                aria-label={`Share ${folder.path} read-only`}
                onCheckedChange={(readOnly) => void change('POST', folder.path, readOnly)}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop sharing ${folder.path}`}
              disabled={busy}
              onClick={() => void change('DELETE', folder.path)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>
        ))}
        actions={
          <>
            {!picker && (
              <Input
                aria-label="Folder path on the computer Nod runs on"
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
