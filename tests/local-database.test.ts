import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEnv } from 'node:util';
import {
  integrationDatabaseUrl,
  localDatabaseEnvironment,
  prepareLocalDatabase,
  rotateLocalDatabase,
  withLocalDatabase,
} from '../scripts/local-database.ts';

async function fixture(content = 'PORT=4310\nDATABASE_URL=\nOPENAI_API_KEY=fixture-model-key\n') {
  const directory = await mkdtemp(join(tmpdir(), 'otto-database-'));
  await writeFile(join(directory, '.env'), content, { mode: 0o644 });
  return {
    directory,
    read: async () => parseEnv(await readFile(join(directory, '.env'), 'utf8')),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('fresh local setup saves a private random password and keeps the server URL stable on restart', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const database = await prepareLocalDatabase(first.directory, {});
    const other = await prepareLocalDatabase(second.directory, {});
    assert.match(database.password, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(database.password, other.password);
    const saved = await first.read();
    assert.equal(saved.OTTO_POSTGRES_PASSWORD, database.password);
    assert.equal(new URL(saved.DATABASE_URL!).password, database.password);
    assert.equal(saved.DATABASE_URL, database.serverDatabaseUrl);
    assert.equal(saved.OPENAI_API_KEY, 'fixture-model-key');
    assert.equal(saved.PORT, '4310');
    assert.equal((await stat(join(first.directory, '.env'))).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(first.directory)).sort(), ['.env', '.local']);
    assert.deepEqual(await readdir(join(first.directory, '.local')), []);
    assert.deepEqual(await prepareLocalDatabase(first.directory, {}), database);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('simultaneous first launches create the template and credentials under the same setup lock', async () => {
  const local = await fixture();
  try {
    await rename(join(local.directory, '.env'), join(local.directory, '.env.example'));
    const [first, second] = await Promise.all([
      prepareLocalDatabase(local.directory, {}),
      prepareLocalDatabase(local.directory, {}),
    ]);
    assert.equal(first.password, second.password);
    const saved = await local.read();
    assert.equal(saved.OTTO_POSTGRES_PASSWORD, first.password);
    assert.equal(saved.OPENAI_API_KEY, 'fixture-model-key');
    assert.equal((await stat(join(local.directory, '.env'))).mode & 0o777, 0o600);
  } finally {
    await local.close();
  }
});

test('legacy local setup replaces the known password without changing unrelated settings', async () => {
  const local = await fixture(
    'PORT=4321\nDATABASE_URL="postgresql://otto:otto-local@localhost:54329/otto"\nOPENAI_API_KEY="fixture key # with spaces"\nDATABASE_URL=postgresql://otto:otto-local@127.0.0.1:54329/otto\n',
  );
  try {
    const database = await prepareLocalDatabase(local.directory, {});
    const saved = await local.read();
    assert.equal(saved.OPENAI_API_KEY, 'fixture key # with spaces');
    assert.equal(saved.PORT, '4321');
    assert.equal(saved.DATABASE_URL, database.databaseUrl);
    assert.notEqual(database.password, 'otto-local');
    const text = await readFile(join(local.directory, '.env'), 'utf8');
    assert.equal(text.match(/^DATABASE_URL=/gm)?.length, 1);
    assert.doesNotMatch(text, /otto-local/);
    const environment = localDatabaseEnvironment(database, { DATABASE_URL: 'stale', PORT: '4321' });
    assert.equal(environment.DATABASE_URL, database.databaseUrl);
    assert.equal(environment.OTTO_POSTGRES_PASSWORD, database.password);
    assert.equal(environment.PORT, '4321');
  } finally {
    await local.close();
  }
});

test('concurrent fresh setup reuses one password and holds the lock through rotation work', async () => {
  const local = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondEntered = false;
  const first = withLocalDatabase(
    local.directory,
    async (database) => {
      entered();
      await blocked;
      return database;
    },
    {},
  );
  await active;
  const second = withLocalDatabase(
    local.directory,
    async (database) => {
      secondEntered = true;
      return database;
    },
    {},
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondEntered, false);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.password, b.password);
    assert.equal((await local.read()).OTTO_POSTGRES_PASSWORD, a.password);
    const [c, d] = await Promise.all([
      prepareLocalDatabase(local.directory, {}),
      prepareLocalDatabase(local.directory, {}),
    ]);
    assert.equal(c.password, d.password);
    await assert.rejects(
      withLocalDatabase(
        local.directory,
        async () => {
          throw new Error('fixture failure');
        },
        {},
      ),
      /fixture failure/,
    );
    assert.equal((await prepareLocalDatabase(local.directory, {})).password, a.password);
  } finally {
    release();
    await Promise.allSettled([first, second]);
    await local.close();
  }
});

test('a terminated setup owner is recovered without replacing a concurrent live lock', async () => {
  const local = await fixture();
  const helper = new URL('../scripts/local-database.ts', import.meta.url).href;
  const script = `
    const { withLocalDatabase } = await import(${JSON.stringify(helper)});
    await withLocalDatabase(${JSON.stringify(local.directory)}, async () => {
      process.stdout.write('locked\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    }, {});
  `;
  const child = spawn(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Fixture setup did not acquire the lock.')),
        5000,
      );
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdout.once('data', (data) => {
        clearTimeout(timeout);
        assert.equal(data.toString(), 'locked\n');
        resolve();
      });
    });
    const before = await local.read();
    child.kill('SIGKILL');
    await closed;
    const [first, second] = await Promise.all([
      prepareLocalDatabase(local.directory, {}),
      prepareLocalDatabase(local.directory, {}),
    ]);
    assert.equal(first.password, before.OTTO_POSTGRES_PASSWORD);
    assert.equal(first.password, second.password);
    assert.deepEqual(await readdir(join(local.directory, '.local')), []);
  } finally {
    child.kill('SIGKILL');
    await closed;
    await local.close();
  }
});

test('custom server databases remain unchanged while the local service receives its own password', async () => {
  const external = 'postgresql://fixture-user:fixture-password@database.example.test/app';
  const local = await fixture(`DATABASE_URL=${external}\n`);
  try {
    const database = await prepareLocalDatabase(local.directory, {});
    assert.equal(database.serverDatabaseUrl, external);
    assert.equal((await local.read()).DATABASE_URL, external);
    assert.equal(new URL(database.databaseUrl).hostname, '127.0.0.1');
    assert.notEqual(database.password, 'fixture-password');
  } finally {
    await local.close();
  }
});

test('configuration rejects unsafe password input and symlinks without exposing supplied values', async () => {
  const local = await fixture();
  const linked = await fixture();
  try {
    const original = await readFile(join(local.directory, '.env'), 'utf8');
    for (const value of ['fixture-short', `${'a'.repeat(43)}\nDROP ROLE otto;`, "'".repeat(43)]) {
      await assert.rejects(
        prepareLocalDatabase(local.directory, { OTTO_POSTGRES_PASSWORD: value }),
        (error: Error) => {
          assert.equal(
            error.message,
            'The local PostgreSQL password must contain at least 43 safe random characters.',
          );
          assert.ok(!error.message.includes(value));
          return true;
        },
      );
    }
    assert.equal(await readFile(join(local.directory, '.env'), 'utf8'), original);
    await rm(join(linked.directory, '.env'));
    await symlink(join(local.directory, '.env'), join(linked.directory, '.env'));
    await assert.rejects(prepareLocalDatabase(linked.directory, {}), /regular private file/);
  } finally {
    await Promise.all([local.close(), linked.close()]);
  }
});

test('existing-volume rotation sends only a SCRAM verifier on stdin to fixed local psql arguments', async () => {
  const local = await fixture();
  try {
    const database = await prepareLocalDatabase(local.directory, {});
    let calls = 0;
    await rotateLocalDatabase(database, {
      environment: {},
      run: async (command, args, options) => {
        calls++;
        assert.equal(command, 'docker');
        assert.deepEqual(args, [
          'compose',
          'exec',
          '-T',
          '--user',
          'postgres',
          'postgres',
          'psql',
          '--no-psqlrc',
          '--username=otto',
          '--dbname=postgres',
          '--set=ON_ERROR_STOP=1',
          '--quiet',
        ]);
        assert.ok(!args.join(' ').includes(database.password));
        assert.ok(!options.input.includes(database.password));
        assert.match(options.input, /^SET log_statement = 'none';/);
        assert.match(
          options.input,
          /ALTER ROLE otto WITH PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+';/,
        );
        assert.doesNotMatch(options.input, /\b(?:DROP|DELETE|TRUNCATE|CREATE)\b/);
        assert.equal(options.env.OTTO_POSTGRES_PASSWORD, database.password);
      },
    });
    assert.equal(calls, 1);
    await assert.rejects(
      rotateLocalDatabase(database, {
        run: async () => {
          throw new Error(database.password);
        },
      }),
      /^Error: The local database password could not be updated\. Existing data was retained\.$/,
    );
    assert.equal((await local.read()).OTTO_POSTGRES_PASSWORD, database.password);
  } finally {
    await local.close();
  }
});

test('integration checks use an explicit test target or configured local credentials without a public fallback', async () => {
  const local = await fixture();
  try {
    await assert.rejects(
      integrationDatabaseUrl(local.directory, {}),
      /TEST_DATABASE_URL explicitly/,
    );
    const database = await prepareLocalDatabase(local.directory, {});
    assert.equal(await integrationDatabaseUrl(local.directory, {}), database.databaseUrl);
    const explicit = 'postgresql://fixture:fixture@database.example.test/disposable';
    assert.equal(
      await integrationDatabaseUrl(local.directory, { TEST_DATABASE_URL: explicit }),
      explicit,
    );
    await assert.rejects(
      integrationDatabaseUrl(local.directory, { DATABASE_URL: explicit }),
      /TEST_DATABASE_URL explicitly/,
    );
    await rm(join(local.directory, '.env'));
    await assert.rejects(
      integrationDatabaseUrl(local.directory, {}),
      /TEST_DATABASE_URL explicitly/,
    );
  } finally {
    await local.close();
  }
});

test('missing database setup permits module imports but fails before database initialization', async () => {
  const local = await fixture();
  try {
    const databaseModule = new URL('../src/server/db.ts', import.meta.url).href;
    const tasksModule = new URL('../src/server/tasks.ts', import.meta.url).href;
    const script = `
      const { initializeDatabase, pool } = await import(${JSON.stringify(databaseModule)});
      await import(${JSON.stringify(tasksModule)});
      try {
        await initializeDatabase();
        process.exitCode = 2;
      } catch (error) {
        if (error.message !== 'Run npm run dev to configure the local database, or set DATABASE_URL.') process.exitCode = 3;
      } finally {
        await pool.end();
      }
    `;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
        {
          cwd: local.directory,
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: '',
            DOTENV_CONFIG_PATH: join(local.directory, 'missing.env'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
  } finally {
    await local.close();
  }
});

test('local database options survive password replacement without retaining an obsolete password', async () => {
  const local = await fixture(
    'DATABASE_URL=postgresql://otto:obsolete@localhost:54329/otto?application_name=otto&sslmode=disable&password=obsolete\n',
  );
  try {
    const database = await prepareLocalDatabase(local.directory, {});
    const url = new URL(database.serverDatabaseUrl);
    assert.equal(url.password, database.password);
    assert.equal(url.searchParams.get('password'), database.password);
    assert.equal(url.searchParams.get('application_name'), 'otto');
    assert.equal(url.searchParams.get('sslmode'), 'disable');
    assert.equal((await local.read()).DATABASE_URL, database.serverDatabaseUrl);
    assert.deepEqual(await prepareLocalDatabase(local.directory, {}), database);
  } finally {
    await local.close();
  }
});

test('duplicate database routing options cannot receive the generated local password', async () => {
  for (const [name, localValue, otherValue] of [
    ['host', 'localhost', 'database.example.test'],
    ['port', '54329', '5432'],
    ['user', 'otto', 'another-user'],
    ['dbname', 'otto', 'another-database'],
    ['database', 'otto', 'another-database'],
  ]) {
    const url = `postgresql://otto:synthetic-old@localhost:54329/otto?${name}=${localValue}&${name}=${otherValue}`;
    const local = await fixture(`DATABASE_URL=${url}\n`);
    try {
      const database = await prepareLocalDatabase(local.directory, {});
      assert.equal(database.serverDatabaseUrl, url, name);
      assert.equal((await local.read()).DATABASE_URL, url, name);
      assert.equal(database.serverDatabaseUrl.includes(database.password), false, name);
      await assert.rejects(
        integrationDatabaseUrl(local.directory, {}),
        /TEST_DATABASE_URL explicitly/,
      );
    } finally {
      await local.close();
    }
  }
});
