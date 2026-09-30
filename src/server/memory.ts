import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrivateObjectStore } from '../ports/object-storage.ts';

const key = 'memory/MEMORY.md';
const maxBytes = 64 * 1024;
const id = z.uuid();
const kind = z.enum(['fact', 'preference', 'pattern']);
const secret =
  /\b(?:password|passcode|passphrase|otp|pin|2fa|api[ _-]?key|secret|token|bearer|private[ _-]?key|security code|cvv|cvc|verification code|recovery code)\b|\bsk-[A-Za-z0-9_-]{12,}|\b(?:\d[ -]?){14,19}\b/i;
const ignored = new Set(
  'about after and are before can for from has have how its now our please should that the their them this user what when where which who with you your'.split(
    ' ',
  ),
);

type Entry = {
  id: string;
  kind: z.infer<typeof kind>;
  text: string;
  sources: string[];
  updated: string;
};

function parse(bytes?: Uint8Array): Entry[] {
  if (!bytes) return [];
  const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!document.startsWith('# Memory\n')) throw new Error('The memory file is invalid.');
  const body = document.slice('# Memory\n'.length).trim();
  if (!body) return [];
  const blocks = body.split(/\n(?=## )/);
  const entries = blocks.map((block) => {
    const match =
      /^## ([0-9a-f-]{36})\nKind: (fact|preference|pattern)\nUpdated: (\d{4}-\d\d-\d\dT[^\n]+)\nSources: ([0-9a-f-, ]+)\n\n([^\n]+)$/.exec(
        block.trim(),
      );
    if (!match) throw new Error('The memory file is invalid.');
    const sources = match[4].split(', ');
    const entry = {
      id: id.parse(match[1]),
      kind: kind.parse(match[2]),
      updated: z.iso.datetime({ offset: true }).parse(match[3]),
      sources: sources.map((source) => id.parse(source)),
      text: z.string().min(1).max(300).parse(match[5]),
    };
    if (sources.length > 5 || secret.test(entry.text))
      throw new Error('The memory file is invalid.');
    return entry;
  });
  if (entries.length > 120 || new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error('The memory file is invalid.');
  return entries;
}

function render(entries: Entry[]) {
  const body = entries
    .map(
      (entry) =>
        `## ${entry.id}\nKind: ${entry.kind}\nUpdated: ${entry.updated}\nSources: ${entry.sources.join(', ')}\n\n${entry.text}`,
    )
    .join('\n\n');
  const bytes = new TextEncoder().encode(`# Memory\n${body ? `\n${body}\n` : ''}`);
  if (bytes.length > maxBytes) throw new Error('The memory file is full.');
  return bytes;
}

function terms(value: string) {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (term) => !ignored.has(term),
    ),
  );
}

function ranked(entries: Entry[], query: string, includePreferences = false) {
  const requested = terms(query);
  return entries
    .map((entry) => {
      const found = terms(entry.text);
      let score = includePreferences && entry.kind === 'preference' ? 1 : 0;
      for (const term of requested) if (found.has(term)) score += 3;
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updated.localeCompare(a.entry.updated))
    .map(({ entry }) => entry);
}

function visible(entry: Entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    status:
      entry.kind === 'pattern' ? (entry.sources.length > 1 ? 'observed' : 'tentative') : 'stated',
    sources: entry.sources,
    updated: entry.updated,
  };
}

export function createMemoryService(options: {
  pool: Pool;
  ownerId: string;
  store: PrivateObjectStore;
}) {
  async function read() {
    const object = await options.store.read(key, maxBytes);
    return { entries: parse(object?.bytes), version: object?.version ?? null };
  }

  async function select(query: string) {
    const { entries } = await read();
    return ranked(entries, query, true)
      .slice(0, 6)
      .map((entry) => visible(entry))
      .map(({ id, kind, text, status }) => ({ id, kind, text, status }));
  }

  async function search(query: string) {
    const { entries } = await read();
    return ranked(entries, query).slice(0, 10).map(visible);
  }

  async function list() {
    return (await read()).entries.map(visible);
  }

  async function save(
    raw: unknown,
    provenance: { sourceMessageId: string | null; turnId: string },
  ) {
    const input = z
      .object({
        id: id.optional(),
        kind,
        text: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .refine((text) => !/[\r\n]/.test(text)),
        replace: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    if (secret.test(input.text))
      throw new Error('Sign-in details and payment secrets cannot be remembered.');
    const sourceMessageId = id.parse(provenance.sourceMessageId);
    const source = await options.pool.query(
      "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND turn_id=$3 AND role='user'",
      [sourceMessageId, options.ownerId, provenance.turnId],
    );
    const sourceText = String(source.rows[0]?.text ?? '').trim();
    if (!sourceText) throw new Error('The current owned user message is required as evidence.');
    if (secret.test(sourceText))
      throw new Error('Sign-in details and payment secrets cannot be remembered.');
    const current = await read();
    const existing = input.id
      ? current.entries.find((entry) => entry.id === input.id)
      : current.entries.find((entry) => entry.text.toLowerCase() === input.text.toLowerCase());
    if (input.id && !existing) throw new Error('The memory entry was not found.');
    if (existing && existing.kind !== input.kind && !input.replace)
      throw new Error('A change of memory type needs a replacement.');
    if (existing && existing.text !== input.text && !input.replace)
      throw new Error('A change of memory text needs a replacement.');
    const entry: Entry = {
      id: existing?.id ?? randomUUID(),
      kind: input.kind,
      text: input.text,
      sources: input.replace
        ? [sourceMessageId]
        : [...new Set([...(existing?.sources ?? []), sourceMessageId])].slice(-5),
      updated: new Date().toISOString(),
    };
    const entries = existing
      ? current.entries.map((item) => (item.id === existing.id ? entry : item))
      : [...current.entries, entry];
    if (entries.length > 120) throw new Error('The memory file is full.');
    await options.store.write(key, render(entries), { expectedVersion: current.version });
    return visible(entry);
  }

  async function forget(raw: unknown) {
    const selected = id.parse(raw);
    const current = await read();
    const entries = current.entries.filter((entry) => entry.id !== selected);
    if (entries.length === current.entries.length)
      throw new Error('The memory entry was not found.');
    await options.store.write(key, render(entries), { expectedVersion: current.version });
    return { ok: true };
  }

  return { select, search, list, save, forget };
}
