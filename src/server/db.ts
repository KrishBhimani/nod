import pg from 'pg';
import { databaseUrl } from './config.ts';

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

export function createInspectorPool() {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 500,
    statement_timeout: 500,
    query_timeout: 750,
  });
}

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, prompt text NOT NULL,
      status text NOT NULL DEFAULT 'queued', revision integer NOT NULL DEFAULT 0, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, owner_id text NOT NULL, role text NOT NULL, text text NOT NULL,
      task_id uuid REFERENCES tasks(id), attachments jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS stream_id text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text;
    CREATE TABLE IF NOT EXISTS task_events (
      id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), type text NOT NULL,
      summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid REFERENCES tasks(id), name text NOT NULL,
      mime_type text NOT NULL, size integer NOT NULL, storage_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_facts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, text text NOT NULL, source_message_id uuid REFERENCES messages(id),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,text)
    );
    CREATE TABLE IF NOT EXISTS preferences (
      owner_id text PRIMARY KEY, notification_rule text NOT NULL DEFAULT '', time_zone text NOT NULL DEFAULT 'Europe/Lisbon',
      quiet_start text NOT NULL DEFAULT '22:00', quiet_end text NOT NULL DEFAULT '08:00'
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY, event_id text UNIQUE NOT NULL, owner_id text NOT NULL, summary text NOT NULL,
      decision text NOT NULL, reason text NOT NULL, feedback text, task_id uuid REFERENCES tasks(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_owner_time ON messages(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS task_events_task_time ON task_events(task_id,created_at);
    CREATE TABLE IF NOT EXISTS inspector_records (
      id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision integer NOT NULL, kind text NOT NULL, name text NOT NULL, status text NOT NULL,
      input jsonb, output jsonb, error text, usage jsonb, duration_ms double precision,
      started_at timestamptz NOT NULL, finished_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS inspector_records_task_time ON inspector_records(owner_id,task_id,started_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS inspector_records_retention ON inspector_records(recorded_at);
  `);
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
