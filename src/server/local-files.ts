import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
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
  stat,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants, type Stats } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { IntegrationError } from './integration-connection.ts';

const readBytes = 256 * 1024;
const writeBytes = 1024 * 1024;
const listLimit = 500;
const batchLimit = 200;
const systemTrash = '/usr/bin/trash';
const statBatch = 100;
const absolute = z.string().min(1).max(4096).refine(isAbsolute, 'Use an absolute path.');
const onePath = z.object({ path: absolute }).strict();
const schemas = {
  LOCAL_FILES_LIST: onePath,
  LOCAL_FILES_READ: onePath,
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
};
type Action = keyof typeof schemas;

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

const run = promisify(execFile);
const maybeLstat = (path: string) => lstat(path).catch(() => undefined);

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function createLocalFiles(
  pool: Pool,
  ownerId: string,
  {
    dataRoot,
    home: homeFolder = homedir(),
    trashFolder,
  }: { dataRoot: string; home?: string; trashFolder?: string },
) {
  const data = realpath(dataRoot).catch(() => dataRoot);
  const homeReal = realpath(homeFolder).catch(() => homeFolder);
  async function privatePath(real: string) {
    const [nodData, home] = await Promise.all([data, homeReal]);
    const inHome = inside(home, real);
    const volume = process.platform === 'darwin' && real !== '/Volumes' && inside('/Volumes', real);
    return (
      !(volume || inHome) ||
      inside(real, home) ||
      inside(real, nodData) ||
      inside(nodData, real) ||
      inside(join(home, 'Library'), real) ||
      (inHome && relative(home, real).startsWith('.'))
    );
  }

  async function folders() {
    const { rows } = await pool.query<{ local_folders: string[] }>(
      'SELECT local_folders FROM preferences WHERE owner_id=$1',
      [ownerId],
    );
    return rows[0]?.local_folders ?? [];
  }

  async function add(path: string) {
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
    if (await privatePath(real))
      throw new IntegrationError(
        "Choose a specific folder. Nod can't share your whole disk, home folder, Library, hidden folders or its own data.",
      );
    const { rows } = await pool.query<{ local_folders: string[] }>(
      `INSERT INTO preferences(owner_id,local_folders) VALUES($1,ARRAY[$2]::text[])
       ON CONFLICT(owner_id) DO UPDATE SET local_folders=
         CASE WHEN $2=ANY(preferences.local_folders) THEN preferences.local_folders
           ELSE array_append(preferences.local_folders,$2) END
       RETURNING local_folders`,
      [ownerId, real],
    );
    return rows[0]!.local_folders;
  }

  async function remove(path: string) {
    const { rows } = await pool.query<{ local_folders: string[] }>(
      `UPDATE preferences SET local_folders=array_remove(local_folders,$2) WHERE owner_id=$1
       RETURNING local_folders`,
      [ownerId, path],
    );
    return rows[0]?.local_folders ?? [];
  }

  async function contained(real: string, roots: string[], allowRoot: boolean, shown: string) {
    if (!(await privatePath(real)))
      for (const root of roots)
        if (
          inside(root, real) &&
          (allowRoot || root !== real) &&
          !relative(root, real)
            .split(sep)
            .some((part) => part.startsWith('.'))
        )
          return real;
    throw new IntegrationError(
      `${shown} is outside the folders the owner shared with Nod, or is hidden.`,
      403,
    );
  }

  async function existing(path: string, roots: string[], allowRoot = true) {
    try {
      return await contained(await realpath(path), roots, allowRoot, path);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (denied(error)) throw new IntegrationError(permissionMessage(path), 403);
      throw new IntegrationError(`${path} does not exist.`, 404);
    }
  }

  async function entry(path: string, roots: string[]) {
    const parent = await existing(dirname(resolve(path)), roots);
    return contained(join(parent, basename(resolve(path))), roots, false, path);
  }

  function resolver(action: Action, roots: string[]) {
    if (action === 'LOCAL_FILES_LIST') return (path: string) => existing(path, roots);
    if (action === 'LOCAL_FILES_READ') return (path: string) => existing(path, roots, false);
    return (path: string) => entry(path, roots);
  }

  async function present(path: string, roots: string[]) {
    const source = await entry(path, roots);
    if (!(await maybeLstat(source))) throw new IntegrationError(`${path} does not exist.`, 404);
    return source;
  }

  async function unchanged(target: string, roots: string[]) {
    if ((await entry(target, roots)) !== target)
      throw new IntegrationError(`The folder of ${target} changed. Nothing was changed.`, 409);
  }

  async function absent(path: string) {
    if (await maybeLstat(path)) throw new IntegrationError(`${path} already exists.`, 409);
  }

  async function freeTrashName(folder: string, name: string) {
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let index = 0; ; index++) {
      const candidate = join(folder, index ? `${stem} ${index}${extension}` : name);
      if (!(await maybeLstat(candidate))) return candidate;
    }
  }

  async function trashReady() {
    if (!trashFolder)
      await access(systemTrash).catch(() => {
        throw new IntegrationError(
          "This computer has no Trash Nod can use, so it didn't trash, replace or edit anything.",
          503,
        );
      });
  }

  async function toTrash(source: string, signal?: AbortSignal) {
    await trashReady();
    if (trashFolder) {
      await mkdir(trashFolder, { recursive: true });
      await rename(source, await freeTrashName(trashFolder, basename(source)));
    } else await run(systemTrash, [source], { signal });
  }

  async function place(source: string, target: string, roots: string[]) {
    await unchanged(target, roots);
    if ((await lstat(source)).isFile()) {
      const linked = await link(source, target).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') throw new IntegrationError(`${target} already exists.`, 409);
          return false;
        },
      );
      if (linked)
        return rm(source).catch(async (error) => {
          await rm(target, { force: true });
          throw error;
        });
    }
    await absent(target);
    await rename(source, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EXDEV') throw error;
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

  async function regularFile(path: string) {
    const info = await maybeLstat(path);
    if (info && !info.isFile()) throw new IntegrationError(`${path} is not a regular file.`);
    if (info && info.mode & 0o111)
      throw new IntegrationError(`${path} is executable. Nod only changes plain files.`);
    return info;
  }

  async function replace(
    path: string,
    text: string,
    previous: Stats | undefined,
    roots: string[],
    signal?: AbortSignal,
  ) {
    if (Buffer.byteLength(text) > writeBytes)
      throw new IntegrationError('The file text must be at most 1 MB.');
    if (previous) await trashReady();
    const temporary = join(dirname(path), `.nod-${randomUUID()}.tmp`);
    await writeFile(temporary, text, { flag: 'wx' });
    if (!previous)
      return place(temporary, path, roots).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
    let backupFolder = '';
    try {
      backupFolder = await mkdtemp(join(dirname(path), '.nod-'));
      await chmod(temporary, previous.mode & 0o7777);
      await link(path, join(backupFolder, basename(path))).catch(() =>
        copyFile(path, join(backupFolder, basename(path))),
      );
      await unchanged(path, roots);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      if (backupFolder) await rm(backupFolder, { recursive: true, force: true });
      throw error;
    }
    const backup = join(backupFolder, basename(path));
    try {
      await toTrash(backup, signal);
      await rm(backupFolder, { recursive: true });
      return 'moved to the Trash';
    } catch {
      return `kept at ${backup}`;
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
    const roots = await folders();
    const real = resolver(action, roots);
    if (input.moves)
      return {
        moves: await Promise.all(
          input.moves.map(async ({ from, to }) => ({ from: await real(from), to: await real(to) })),
        ),
      };
    if (input.paths) return { paths: await Promise.all(input.paths.map(real)) };
    return { ...input, path: await real(input.path!) };
  }

  async function execute(action: Action, args: Record<string, unknown>, signal?: AbortSignal) {
    const input = validate(action, args) as Input;
    const roots = await folders();
    const target = resolver(action, roots);
    if (action === 'LOCAL_FILES_LIST') {
      const path = await target(input.path);
      const names = (await readdir(path, { withFileTypes: true })).filter(
        (item) => !item.name.startsWith('.'),
      );
      const entries = [];
      for (let start = 0; start < names.length; start += statBatch) {
        signal?.throwIfAborted();
        entries.push(
          ...(await Promise.all(
            names.slice(start, start + statBatch).map(async (item) => {
              const info = await maybeLstat(join(path, item.name));
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
      if (!(await maybeLstat(path))?.isFile()) throw new IntegrationError(`${path} is not a file.`);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new IntegrationError(`${path} is not a file.`);
        const { buffer, bytesRead } = await file.read(Buffer.alloc(readBytes), 0, readBytes, 0);
        const bytes = buffer.subarray(0, bytesRead);
        const truncated = info.size > readBytes;
        if (bytes.includes(0)) return { path, size: info.size, binary: true };
        return {
          path,
          size: info.size,
          text: new TextDecoder().decode(bytes, { stream: truncated }),
          ...(truncated ? { truncated } : {}),
        };
      } finally {
        await file.close();
      }
    }
    if (action === 'LOCAL_FILES_CREATE_FOLDER') {
      const path = await target(input.path);
      await absent(path);
      await mkdir(path);
      return { created: path };
    }
    if (action === 'LOCAL_FILES_WRITE') {
      const path = await target(input.path);
      const previous = await regularFile(path);
      if (previous && !input.overwrite)
        throw new IntegrationError(`${path} already exists. Set overwrite to replace it.`, 409);
      const previousVersion = await replace(path, input.text, previous, roots, signal);
      return { written: path, ...(previousVersion ? { previousVersion } : {}) };
    }
    if (action === 'LOCAL_FILES_EDIT') {
      const path = await target(input.path);
      const info = await regularFile(path);
      if (!info) throw new IntegrationError(`${path} does not exist.`, 404);
      if (info.size > writeBytes)
        throw new IntegrationError('Only files up to 1 MB can be edited.');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = await handle.readFile().finally(() => handle.close());
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
      return { edited: path, previousVersion: await replace(path, text, info, roots, signal) };
    }
    if (action === 'LOCAL_FILES_MOVE') {
      const { done, failed } = await each(
        input.moves,
        async ({ from, to }) => {
          const source = await present(from, roots);
          const destination = await target(to);
          await place(source, destination, roots);
          return { from: source, to: destination };
        },
        signal,
      );
      return { moved: done, failed };
    }
    const { done, failed } = await each(
      input.paths,
      async (path) => {
        const source = await present(path, roots);
        await toTrash(source, signal);
        return source;
      },
      signal,
    );
    return { trashed: done, failed };
  }

  function tools(shared: string[]) {
    if (!shared.length) return {};
    const where = `Only inside the owner's shared folders: ${shared.join(', ')}.`;
    return {
      LOCAL_FILES_LIST: {
        description: `List a folder on the owner's computer, newest first. ${where}`,
        parameters: { path: 'Absolute folder path.' },
      },
      LOCAL_FILES_READ: {
        description: `Read up to 256 KB of a text file on the owner's computer. ${where}`,
        parameters: { path: 'Absolute file path.' },
      },
      LOCAL_FILES_CREATE_FOLDER: {
        description: `Create one folder. ${where}`,
        parameters: { path: 'Absolute path of the new folder; its parent must exist.' },
      },
      LOCAL_FILES_MOVE: {
        description: `Move or rename up to ${batchLimit} files or folders. Never overwrites. ${where}`,
        parameters: { moves: 'Array of {from, to} absolute paths.' },
      },
      LOCAL_FILES_WRITE: {
        description: `Create a text file, or replace one with overwrite:true; the replaced version goes to the Trash. Up to 1 MB. ${where}`,
        parameters: {
          path: 'Absolute file path; its folder must exist.',
          text: 'Complete file contents.',
          overwrite: 'Optional. true replaces an existing file.',
        },
      },
      LOCAL_FILES_EDIT: {
        description: `Replace exact text in a text file of up to 1 MB; each oldText must appear exactly once. The previous version goes to the Trash. ${where}`,
        parameters: {
          path: 'Absolute file path.',
          edits: 'Array of {oldText, newText}, applied in order.',
        },
      },
      LOCAL_FILES_TRASH: {
        description: `Move up to ${batchLimit} files or folders to the Trash, where the owner can restore them. ${where}`,
        parameters: { paths: 'Array of absolute paths.' },
      },
    };
  }

  function registerRoutes(app: FastifyInstance) {
    const body = z.object({ path: z.string() }).strict();
    app.get('/api/local-files', async () => ({ folders: await folders() }));
    app.post('/api/local-files', async (request) => ({
      folders: await add(body.parse(request.body).path),
    }));
    app.delete('/api/local-files', async (request) => ({
      folders: await remove(body.parse(request.body).path),
    }));
  }

  return { folders, add, prepare, execute, tools, registerRoutes };
}

export type LocalFiles = ReturnType<typeof createLocalFiles>;
