import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrivateObjectStore } from '../ports/object-storage.ts';

const key = 'memory/MEMORY.md';
const maxBytes = 64 * 1024;
const maxEntries = 50;
const id = z.uuid();
const kind = z.enum(['fact', 'preference', 'pattern']);
const secret =
  /\b(?:password|passcode|passphrase|otp|pin|2fa|api[ _-]?key|secret|token|bearer|private[ _-]?key|security code|cvv|cvc|verification code|recovery code)\b|\bsk-[A-Za-z0-9_-]{12,}|\b(?:\d[ -]?){14,19}\b/i;
const block =
  /^## ([0-9a-f-]{36})\nKind: (fact|preference|pattern)\nUpdated: (\d{4}-\d\d-\d\dT[^\n]+)\nSources: ([0-9a-f-, ]+)\n\n([^\n]+)$/;
const entrySchema = z.object({
  id,
  kind,
  updated: z.iso.datetime({ offset: true }),
  sources: z.array(id).min(1).max(5),
  text: z.string().min(1).max(300),
});

type Entry = z.infer<typeof entrySchema>;

// Invalid blocks are skipped so one bad entry cannot disable memory; the next write drops them.
function parse(bytes?: Uint8Array): Entry[] {
  if (!bytes) return [];
  const body = new TextDecoder().decode(bytes).replace(/^# Memory\n/, '');
  const entries = new Map<string, Entry>();
  for (const part of body.split(/\n(?=## )/)) {
    const match = block.exec(part.trim());
    const entry = entrySchema.safeParse(
      match && {
        id: match[1],
        kind: match[2],
        updated: match[3],
        sources: match[4].split(', '),
        text: match[5],
      },
    );
    if (entry.success && !entries.has(entry.data.id)) entries.set(entry.data.id, entry.data);
  }
  return [...entries.values()];
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

  async function context() {
    const { entries } = await read();
    return entries
      .toSorted((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, maxEntries)
      .map((entry) => visible(entry))
      .map(({ id, kind, text, status }) => ({ id, kind, text, status }));
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
      "SELECT 1 FROM messages WHERE id=$1 AND owner_id=$2 AND turn_id=$3 AND role='user'",
      [sourceMessageId, options.ownerId, provenance.turnId],
    );
    if (!source.rowCount)
      throw new Error('The current owned user message is required as evidence.');
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
    if (!existing && entries.length > maxEntries) throw new Error('The memory file is full.');
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

  return { context, list, save, forget };
}
