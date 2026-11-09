import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { IntegrationFile } from '../ports/integrations.ts';
import type { Trash } from '../ports/trash.ts';
import { fileBytes, fileMimeType } from '../shared/files.ts';
import type { CaptureAnalytics } from './analytics.ts';
import { captureConnection } from './analytics-connections.ts';
import { workspaceFileInput, workspaceFileReference } from './integration-files.ts';
import { IntegrationError } from './integration-connection.ts';

const readBytes = 256 * 1024;
const writeBytes = 1024 * 1024;
const listLimit = 500;
const batchLimit = 200;
const statBatch = 100;
const noFollow = constants.O_NOFOLLOW ?? 0;
const noBlock = constants.O_NONBLOCK ?? 0;
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      nodePath.isAbsolute(value) && (process.platform !== 'win32' || !value.slice(2).includes(':')),
    'Use an absolute path.',
  );
const onePath = z.object({ path: absolute }).strict();
const schemas = {
  LOCAL_FILES_LIST: onePath,
  LOCAL_FILES_READ: onePath,
  LOCAL_FILES_IMPORT: onePath,
  LOCAL_FILES_CREATE_FOLDER: onePath,
  LOCAL_FILES_MOVE: z
    .object({
      moves: z
        .array(z.object({ from: absolute, to: absolute }).strict())
        .min(1)
        .max(batchLimit),
    })
    .strict(),
  LOCAL_FILES_TRASH: z.object({ paths: z.array(absolute).min(1).max(batchLimit) }).strict(),
  LOCAL_FILES_WRITE: z
    .object({ path: absolute, text: z.string().max(writeBytes), overwrite: z.boolean().optional() })
    .strict(),
  LOCAL_FILES_EDIT: z
    .object({
      path: absolute,
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict())
        .min(1)
        .max(50),
    })
    .strict(),
  LOCAL_FILES_EXPORT: z
    .object({ file: workspaceFileReference, path: absolute, overwrite: z.boolean().optional() })
    .strict(),
};
type Action = keyof typeof schemas;
const reads = new Set<Action>(['LOCAL_FILES_LIST', 'LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT']);
const windowsHidden = new Set([
  'desktop.ini',
  'thumbs.db',
  '$recycle.bin',
  'system volume information',
]);
const programs: Partial<Record<NodeJS.Platform, RegExp>> = {
  win32:
    /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|msc|lnk|pif|scr|cpl|hta|reg|dll|url|appref-ms|jar|chm|scf|library-ms|searchconnector-ms|settingcontent-ms)$/i,
  darwin:
    /\.(command|tool|terminal|app|pkg|mpkg|workflow|scpt|scptd|applescript|sh|bash|zsh|jar|webloc|inetloc|fileloc)$/i,
  linux: /\.(sh|bash|desktop|run|appimage|jar)$/i,
};
const run = promisify(execFile);
const maybeLstat = (path: string) => lstat(path).catch(() => undefined);

export type LocalFolder = { path: string; readOnly: boolean };
export type WorkspaceRead = (input: z.infer<typeof workspaceFileReference>) => Promise<Uint8Array>;

function denied(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES';
}

function permissionMessage(path: string) {
  return process.platform === 'darwin'
    ? `Nod can't open ${path}. Allow Nod in System Settings, Privacy & Security, Files and Folders (or Full Disk Access), then try again.`
    : `Nod can't open ${path}.`;
}

export function isLocalFilesAction(action: string): action is Action {
  return Object.hasOwn(schemas, action);
}

export function localFileRules(
  platform: NodeJS.Platform,
  home: string,
  dataRoot: string,
  systemDrive = 'C:',
) {
  const path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const key = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  function inside(root: string, target: string) {
    const rel = path.relative(key(root), key(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  function hiddenName(name: string) {
    return name.startsWith('.') || (platform === 'win32' && windowsHidden.has(name.toLowerCase()));
  }
  function hiddenBelow(root: string, target: string) {
    return path.relative(root, target).split(path.sep).filter(Boolean).some(hiddenName);
  }
  function volume(target: string) {
    if (platform === 'darwin' && target !== '/Volumes' && inside('/Volumes', target))
      return path.join('/Volumes', path.relative('/Volumes', target).split(path.sep)[0]!);
    if (
      platform === 'win32' &&
      /^[a-z]:\\/i.test(target) &&
      key(target.slice(0, 2)) !== key(systemDrive)
    )
      return target.slice(0, 3);
  }
  const library =
    platform === 'darwin'
      ? path.join(home, 'Library')
      : platform === 'win32'
        ? path.join(home, 'AppData')
        : undefined;
  return {
    inside,
    same: (left: string, right: string) => key(left) === key(right),
    hiddenName,
    hiddenBelow,
    privateFolder(real: string) {
      const anchor = inside(home, real) ? home : volume(real);
      return (
        !anchor ||
        inside(real, home) ||
        inside(real, dataRoot) ||
        inside(dataRoot, real) ||
        (library !== undefined && inside(library, real)) ||
        hiddenBelow(anchor, real)
      );
    },
    program: (name: string) => programs[platform]?.test(name) ?? false,
    executable: (name: string, mode: number) =>
      (programs[platform]?.test(name) ?? false) || (platform !== 'win32' && (mode & 0o111) !== 0),
  };
}

export function createLocalFiles(
  pool: Pool,
  ownerId: string,
  options: {
    dataRoot: string;
    home?: string;
    trash?: Trash;
    available?: boolean;
    analytics?: CaptureAnalytics;
    consentRevision?: () => string | undefined;
  },
) {
  const available = options.available ?? true;
  const home = options.home ?? homedir();
  const rules = Promise.all([
    realpath(home).catch(() => home),
    realpath(options.dataRoot).catch(() => options.dataRoot),
  ]).then(([realHome, realData]) =>
    localFileRules(process.platform, realHome, realData, process.env.SystemDrive),
  );

  function track(status: 'connected' | 'disconnected') {
    captureConnection(
      options.analytics,
      { connection_method: 'local', consentRevision: options.consentRevision?.() },
      status,
    );
  }

  function shaped(row?: { local_folders: string[]; local_folders_read_only: string[] }) {
    return (row?.local_folders ?? []).map((path) => ({
      path,
      readOnly: row!.local_folders_read_only.includes(path),
    }));
  }

  async function folders(): Promise<LocalFolder[]> {
    if (!available) return [];
    const { rows } = await pool.query(
      'SELECT local_folders,local_folders_read_only FROM preferences WHERE owner_id=$1',
      [ownerId],
    );
    return shaped(rows[0]);
  }

  async function add(path: string, readOnly?: boolean) {
    if (!available)
      throw new IntegrationError(
        'Local files work only when Nod runs on your own computer, not on a hosted server.',
        503,
      );
    const input = absolute.safeParse(path.trim());
    if (!input.success) throw new IntegrationError('Enter the absolute path of a folder.');
    let real: string;
    try {
      real = await realpath(input.data);
      if (!(await stat(real)).isDirectory()) throw new IntegrationError('Choose a folder.');
      await readdir(real);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (denied(error)) throw new IntegrationError(permissionMessage(input.data), 403);
      throw new IntegrationError('This folder does not exist.', 404);
    }
    if ((await rules).privateFolder(real))
      throw new IntegrationError(
        "Choose a specific folder in your home folder or on an external drive. Nod can't share your whole disk, home folder, Library, hidden folders or its own data.",
      );
    const before = (await folders()).length;
    const { rows } = await pool.query(
      `INSERT INTO preferences(owner_id,local_folders,local_folders_read_only)
       VALUES($1,ARRAY[$2]::text[],CASE WHEN $3::boolean IS TRUE THEN ARRAY[$2]::text[] ELSE '{}'::text[] END)
       ON CONFLICT(owner_id) DO UPDATE SET
         local_folders=CASE WHEN $2=ANY(preferences.local_folders) THEN preferences.local_folders
           ELSE array_append(preferences.local_folders,$2) END,
         local_folders_read_only=CASE WHEN $3::boolean IS NULL THEN preferences.local_folders_read_only
           WHEN $3::boolean THEN array_append(array_remove(preferences.local_folders_read_only,$2),$2)
           ELSE array_remove(preferences.local_folders_read_only,$2) END
       RETURNING local_folders,local_folders_read_only`,
      [ownerId, real, readOnly ?? null],
    );
    const shared = shaped(rows[0]);
    if (!before && shared.length) track('connected');
    return shared;
  }

  async function remove(path: string) {
    const before = (await folders()).length;
    const { rows } = await pool.query(
      `UPDATE preferences SET local_folders=array_remove(local_folders,$2),
         local_folders_read_only=array_remove(local_folders_read_only,$2)
       WHERE owner_id=$1 RETURNING local_folders,local_folders_read_only`,
      [ownerId, path],
    );
    const shared = shaped(rows[0]);
    if (before && !shared.length) track('disconnected');
    return shared;
  }

  async function contained(
    real: string,
    roots: LocalFolder[],
    allowRoot: boolean,
    shown: string,
    write: boolean,
  ) {
    const rule = await rules;
    const matches = rule.privateFolder(real)
      ? []
      : roots.filter(
          (root) =>
            rule.inside(root.path, real) &&
            (allowRoot || !rule.same(root.path, real)) &&
            !rule.hiddenBelow(root.path, real),
        );
    if (!matches.length) throw outside(shown);
    if (write && matches.some((root) => root.readOnly))
      throw new IntegrationError(
        `${shown} is in a folder the owner shared read-only. Nothing was changed.`,
        403,
      );
    return real;
  }

  function outside(path: string) {
    return new IntegrationError(
      `${path} is outside the folders the owner shared with Nod, or is hidden.`,
      403,
    );
  }

  async function existing(path: string, roots: LocalFolder[], allowRoot: boolean, write: boolean) {
    const fold = (value: string) => (process.platform === 'linux' ? value : value.toLowerCase());
    const lexical = fold(nodePath.resolve(path));
    if (
      !roots.some((root) => {
        const rel = nodePath.relative(fold(root.path), lexical);
        return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
      })
    )
      throw outside(path);
    try {
      return await contained(await realpath(path), roots, allowRoot, path, write);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (denied(error)) throw new IntegrationError(permissionMessage(path), 403);
      throw new IntegrationError(`${path} does not exist.`, 404);
    }
  }

  async function entry(path: string, roots: LocalFolder[]) {
    const parent = await existing(nodePath.dirname(nodePath.resolve(path)), roots, true, true);
    return contained(
      nodePath.join(parent, nodePath.basename(nodePath.resolve(path))),
      roots,
      false,
      path,
      true,
    );
  }

  function resolver(action: Action, roots: LocalFolder[]) {
    if (action === 'LOCAL_FILES_LIST') return (path: string) => existing(path, roots, true, false);
    if (reads.has(action)) return (path: string) => existing(path, roots, false, false);
    return (path: string) => entry(path, roots);
  }

  async function present(path: string, roots: LocalFolder[]) {
    const source = await entry(path, roots);
    if (!(await maybeLstat(source))) throw new IntegrationError(`${path} does not exist.`, 404);
    return source;
  }

  async function unchanged(target: string, roots: LocalFolder[]) {
    if (!(await rules).same(await entry(target, roots), target))
      throw new IntegrationError(`The folder of ${target} changed. Nothing was changed.`, 409);
  }

  async function absent(path: string) {
    if (await maybeLstat(path)) throw new IntegrationError(`${path} already exists.`, 409);
  }

  async function trashReady() {
    if (!(await options.trash?.ready()))
      throw new IntegrationError(
        "This computer has no Trash Nod can use, so it didn't trash, replace or edit anything.",
        503,
      );
  }

  async function toTrash(source: string, signal?: AbortSignal) {
    await trashReady();
    await options.trash!.put(source, signal);
  }

  function taken(target: string) {
    return new IntegrationError(`${target} already exists.`, 409);
  }

  async function place(source: string, target: string, roots: LocalFolder[]) {
    await unchanged(target, roots);
    const info = await lstat(source);
    const current = await maybeLstat(target);
    if (current?.ino === info.ino && current.dev === info.dev) return rename(source, target);
    const fail = (error: NodeJS.ErrnoException) => {
      throw error.code === 'EEXIST' ? taken(target) : error;
    };
    if (info.isFile()) {
      const linked = await link(source, target).then(
        () => true,
        (error: NodeJS.ErrnoException) => (error.code === 'EEXIST' ? fail(error) : false),
      );
      if (!linked) await copyFile(source, target, constants.COPYFILE_EXCL).catch(fail);
      return rm(source).catch(async (error) => {
        await rm(target, { force: true });
        throw error;
      });
    }
    if (info.isDirectory() && process.platform !== 'win32') {
      await mkdir(target).catch(fail);
      return rename(source, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EXDEV') {
          await rmdir(target).catch(() => undefined);
          throw error;
        }
        await cp(source, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        });
        await rm(source, { recursive: true });
      });
    }
    await absent(target);
    await rename(source, target);
  }

  async function regularFile(path: string) {
    const info = await maybeLstat(path);
    if (info && !info.isFile()) throw new IntegrationError(`${path} is not a regular file.`);
    if (info && (await rules).executable(path, info.mode))
      throw new IntegrationError(`${path} is executable. Nod only changes plain files.`);
    return info;
  }

  async function replace(
    path: string,
    data: string | Uint8Array,
    previous: Stats | undefined,
    roots: LocalFolder[],
    signal?: AbortSignal,
  ) {
    if (previous) await trashReady();
    const folder = nodePath.dirname(path);
    const temporary = nodePath.join(folder, `.nod-${randomUUID()}.tmp`);
    await writeFile(temporary, data, { flag: 'wx' });
    if (!previous)
      return place(temporary, path, roots).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
    let backupFolder = '';
    let kept = '';
    try {
      backupFolder = await mkdtemp(nodePath.join(folder, '.nod-'));
      kept = nodePath.join(backupFolder, nodePath.basename(path));
      await chmod(temporary, previous.mode & 0o7777);
      await link(path, kept).catch(() => copyFile(path, kept));
      await unchanged(path, roots);
      await toTrash(path, signal);
    } catch (error) {
      await rm(temporary, { force: true });
      if (backupFolder) await rm(backupFolder, { recursive: true, force: true });
      throw error;
    }
    try {
      await place(temporary, path, roots);
    } catch {
      await rm(temporary, { force: true });
      const restored = await place(kept, path, roots).then(
        () => true,
        () => false,
      );
      if (restored) await rm(backupFolder, { recursive: true, force: true });
      throw new IntegrationError(
        restored
          ? `${path} was not replaced and is unchanged. A copy of it is in the Trash.`
          : `${path} was not replaced. Its previous version is in the Trash.`,
        409,
      );
    }
    await rm(backupFolder, { recursive: true, force: true });
    return 'moved to the Trash';
  }

  async function quarantine(path: string) {
    if (process.platform !== 'darwin') return;
    const stamp = Math.floor(Date.now() / 1000).toString(16);
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${stamp};Nod;`, path]).catch(
      () => undefined,
    );
  }

  async function readFile(path: string, limit: number) {
    if (!(await maybeLstat(path))?.isFile()) throw new IntegrationError(`${path} is not a file.`);
    const file = await open(path, constants.O_RDONLY | noFollow | noBlock);
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, limit);
      const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, 0);
      return { size, bytes: buffer.subarray(0, bytesRead) };
    } finally {
      await file.close();
    }
  }

  async function each<T>(items: T[], task: (item: T) => Promise<unknown>, signal?: AbortSignal) {
    const done: unknown[] = [];
    const failed: Array<{ item: T; error: string }> = [];
    for (const item of items) {
      signal?.throwIfAborted();
      try {
        done.push(await task(item));
      } catch (error) {
        failed.push({ item, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { done, failed };
  }

  type Input = {
    path: string;
    moves: Array<{ from: string; to: string }>;
    paths: string[];
    text: string;
    overwrite?: boolean;
    edits: Array<{ oldText: string; newText: string }>;
    file: z.infer<typeof workspaceFileReference>;
  };

  function validate(action: Action, args: Record<string, unknown>) {
    const parsed = schemas[action].safeParse(args);
    if (!parsed.success)
      throw new IntegrationError(
        `Invalid ${action} arguments: ${z.prettifyError(parsed.error)}. Nothing was changed.`,
      );
    return parsed.data as Partial<Input>;
  }

  async function prepare(action: Action, args: Record<string, unknown>) {
    const input = validate(action, args);
    const real = resolver(action, await folders());
    if (input.moves)
      return {
        moves: await Promise.all(
          input.moves.map(async ({ from, to }) => ({ from: await real(from), to: await real(to) })),
        ),
      };
    if (input.paths) return { paths: await Promise.all(input.paths.map(real)) };
    return { ...input, path: await real(input.path!) };
  }

  async function execute(
    action: Action,
    args: Record<string, unknown>,
    context: { signal?: AbortSignal; read?: WorkspaceRead } = {},
  ) {
    const { signal } = context;
    const input = validate(action, args) as Input;
    const roots = await folders();
    const rule = await rules;
    const resolve = resolver(action, roots);
    const bound = (resolved: string, requested: string) => {
      if (!rule.same(resolved, requested))
        throw new IntegrationError(
          `${requested} now leads somewhere else than when this action was checked. Nothing was changed.`,
          409,
        );
      return resolved;
    };
    const target = async (path: string) => bound(await resolve(path), path);
    const destination = async (path: string) => {
      const resolved = await target(path);
      if (rule.program(resolved) || (process.platform === 'win32' && /[. ]$/.test(resolved)))
        throw new IntegrationError(
          `${path} would be a program or shortcut. Nod only creates plain files.`,
        );
      return resolved;
    };
    if (action === 'LOCAL_FILES_LIST') {
      const path = await target(input.path);
      const names = (await readdir(path, { withFileTypes: true })).filter(
        (item) => !rule.hiddenName(item.name),
      );
      const entries = [];
      for (let start = 0; start < names.length; start += statBatch) {
        signal?.throwIfAborted();
        entries.push(
          ...(await Promise.all(
            names.slice(start, start + statBatch).map(async (item) => {
              const info = await maybeLstat(nodePath.join(path, item.name));
              return {
                name: item.name,
                kind: item.isDirectory() ? 'folder' : item.isSymbolicLink() ? 'link' : 'file',
                size: info?.size,
                modified: info?.mtime.toISOString(),
              };
            }),
          )),
        );
      }
      entries.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
      return {
        path,
        total: names.length,
        entries: entries.slice(0, listLimit),
        ...(names.length > listLimit ? { truncated: true } : {}),
      };
    }
    if (action === 'LOCAL_FILES_READ') {
      const path = await target(input.path);
      const { size, bytes } = await readFile(path, readBytes);
      const truncated = size > readBytes;
      if (bytes.includes(0)) return { path, size, binary: true };
      return {
        path,
        size,
        text: new TextDecoder().decode(bytes, { stream: truncated }),
        ...(truncated ? { truncated } : {}),
      };
    }
    if (action === 'LOCAL_FILES_IMPORT') {
      const path = await target(input.path);
      if (((await maybeLstat(path))?.size ?? 0) > fileBytes)
        throw new IntegrationError(`Files up to ${fileBytes / 1024 / 1024} MB can be copied.`);
      const { size, bytes } = await readFile(path, fileBytes);
      const name = nodePath.basename(path);
      const file: IntegrationFile = { name, mimeType: fileMimeType(name), bytes };
      return { path, size, file };
    }
    if (action === 'LOCAL_FILES_CREATE_FOLDER') {
      const path = await destination(input.path);
      await absent(path);
      await mkdir(path);
      return { created: path };
    }
    if (action === 'LOCAL_FILES_WRITE' || action === 'LOCAL_FILES_EXPORT') {
      const path = await destination(input.path);
      const previous = await regularFile(path);
      if (previous && !input.overwrite)
        throw new IntegrationError(`${path} already exists. Set overwrite to replace it.`, 409);
      let data: string | Uint8Array = input.text;
      if (action === 'LOCAL_FILES_EXPORT') {
        if (!context.read) throw new IntegrationError('Workspace files are unavailable.', 503);
        data = await context.read(input.file);
      }
      const previousVersion = await replace(path, data, previous, roots, signal);
      await quarantine(path);
      return { written: path, ...(previousVersion ? { previousVersion } : {}) };
    }
    if (action === 'LOCAL_FILES_EDIT') {
      const path = await target(input.path);
      const info = await regularFile(path);
      if (!info) throw new IntegrationError(`${path} does not exist.`, 404);
      if (info.size > writeBytes)
        throw new IntegrationError('Only files up to 1 MB can be edited.');
      const { bytes } = await readFile(path, writeBytes);
      let text: string;
      try {
        if (bytes.includes(0)) throw new Error();
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new IntegrationError(`${path} is not a UTF-8 text file. Nothing was changed.`);
      }
      for (const { oldText, newText } of input.edits) {
        const at = text.indexOf(oldText);
        if (at < 0 || text.indexOf(oldText, at + 1) >= 0)
          throw new IntegrationError(
            `Each oldText must appear exactly once in ${path}. Nothing was changed.`,
          );
        text = text.slice(0, at) + newText + text.slice(at + oldText.length);
      }
      if (Buffer.byteLength(text) > writeBytes)
        throw new IntegrationError('The edited file would be over 1 MB. Nothing was changed.');
      const previousVersion = await replace(path, text, info, roots, signal);
      await quarantine(path);
      return { edited: path, previousVersion };
    }
    if (action === 'LOCAL_FILES_MOVE') {
      const { done, failed } = await each(
        input.moves,
        async ({ from, to }) => {
          const source = bound(await present(from, roots), from);
          const moved = await destination(to);
          await place(source, moved, roots);
          return { from: source, to: moved };
        },
        signal,
      );
      return { moved: done, failed };
    }
    const { done, failed } = await each(
      input.paths,
      async (path) => {
        const source = bound(await present(path, roots), path);
        await toTrash(source, signal);
        return source;
      },
      signal,
    );
    return { trashed: done, failed };
  }

  const descriptions: Record<Action, string> = {
    LOCAL_FILES_LIST:
      "List a folder on the owner's computer, newest first. Hidden files are left out.",
    LOCAL_FILES_READ: "Read up to 256 KB of a text file on the owner's computer.",
    LOCAL_FILES_IMPORT: `Copy a file of up to ${fileBytes / 1024 / 1024} MB, such as a PDF or image, from the owner's computer into the workspace to work with it there.`,
    LOCAL_FILES_CREATE_FOLDER: 'Create one folder; its parent must exist.',
    LOCAL_FILES_MOVE: `Move or rename up to ${batchLimit} files or folders. Never overwrites.`,
    LOCAL_FILES_WRITE:
      'Create a text file of up to 1 MB, or replace one with overwrite:true; the replaced version goes to the Trash.',
    LOCAL_FILES_EDIT:
      'Replace exact text in a text file of up to 1 MB; each oldText must appear exactly once. The previous version goes to the Trash.',
    LOCAL_FILES_EXPORT:
      "Copy a workspace file to the owner's computer. Set overwrite:true to replace a file; the replaced version goes to the Trash.",
    LOCAL_FILES_TRASH: `Move up to ${batchLimit} files or folders to the Trash, where the owner can restore them.`,
  };

  function tools(shared: LocalFolder[], query: string) {
    if (!shared.length) return {};
    const vocabulary = new Set([
      'local',
      'file',
      'files',
      'folder',
      'folders',
      'computer',
      'disk',
      'drive',
      'trash',
      'desktop',
      'downloads',
      'documents',
      ...Object.keys(schemas).map((action) => action.toLowerCase()),
      ...shared.map((folder) => nodePath.basename(folder.path).toLowerCase()),
    ]);
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
    if (!terms.some((term) => vocabulary.has(term))) return {};
    const where = `Only inside the owner's shared folders: ${shared
      .map((folder) => `${folder.path}${folder.readOnly ? ' (read-only)' : ''}`)
      .join(', ')}.`;
    return Object.fromEntries(
      (Object.keys(schemas) as Action[])
        .filter((action) => reads.has(action) || shared.some((folder) => !folder.readOnly))
        .map((action) => [
          action,
          {
            description: `${descriptions[action]} ${where}`,
            inputSchema: z.toJSONSchema(
              action === 'LOCAL_FILES_EXPORT'
                ? schemas[action].extend({ file: workspaceFileInput })
                : schemas[action],
            ),
          },
        ]),
    );
  }

  function registerRoutes(app: FastifyInstance) {
    const body = z.object({ path: z.string(), readOnly: z.boolean().optional() }).strict();
    app.get('/api/local-files', async () => ({ available, folders: await folders() }));
    app.post('/api/local-files', async (request) => {
      const input = body.parse(request.body);
      return { available, folders: await add(input.path, input.readOnly) };
    });
    app.delete('/api/local-files', async (request) => ({
      available,
      folders: await remove(body.parse(request.body).path),
    }));
  }

  return { available, folders, add, prepare, execute, tools, registerRoutes };
}

export type LocalFiles = ReturnType<typeof createLocalFiles>;
