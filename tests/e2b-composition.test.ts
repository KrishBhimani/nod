import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('composition binds one E2B template to the process owner and keeps preparation separate from startup', () => {
  const base = new URL('../src/', import.meta.url).href;
  for (const mode of ['local', 'tenant'] as const) {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const modules = new Map([
        [${JSON.stringify(base + 'providers/e2b/index.ts')}, 'export const createE2BAdapters=(options)=>{globalThis.computerOptions=options;return {computer:{status:()=>"e2b"},workspace:{status:()=>"e2b"},prepare:async()=>{globalThis.prepared=true},pause:async()=>{globalThis.paused=true},resume:async()=>{globalThis.resumed=true}}}'],
        [${JSON.stringify(base + 'server/computer-allocations.ts')}, 'export const createComputerAllocationStore=(options)=>({initialize:async()=>{globalThis.initializedOwner=options.ownerId}})'],
        [${JSON.stringify(base + 'server/object-storage.ts')}, 'export const createPostgresObjectStore=()=>({initialize:async()=>{}})'],
      ]);
      registerHooks({load(url, context, next){const source=modules.get(url);return source===undefined?next(url,context):{format:'module',source,shortCircuit:true}}});
      globalThis.fetch=()=>{throw new Error('Unexpected provider request')};
      const {createDefaultAdapters}=await import(${JSON.stringify(base + 'server/composition.ts')});
      const environment={...process.env,COMPUTER_PROVIDER:'e2b',E2B_API_KEY:'synthetic-unused',E2B_COMPUTER_TEMPLATE:'combined-template',OTTO_CONTROL_URL:'http://otto.control',OBJECT_STORAGE_PROVIDER:'postgres'};
      const adapters=createDefaultAdapters(environment);
      assert.equal(adapters.computer.status(),'e2b');
      assert.equal(globalThis.computerOptions.ownerId,${JSON.stringify(mode === 'local' ? 'local-development' : owner)});
      assert.equal(globalThis.computerOptions.templateId,'combined-template');
      assert.equal(globalThis.computerOptions.templates,undefined);
      assert.equal(globalThis.prepared,undefined);
      await adapters.initialize();
      assert.equal(globalThis.initializedOwner,${JSON.stringify(mode === 'local' ? 'local-development' : owner)});
      assert.equal(globalThis.prepared,undefined);
      await adapters.prepareComputer();
      await adapters.computerLifecycle.pause();
      await adapters.computerLifecycle.resume();
      assert.equal(globalThis.prepared,true);
      assert.equal(globalThis.paused,true);
      assert.equal(globalThis.resumed,true);
      assert.equal(adapters.confirmComputerShutdown,undefined);
      for (const key of ['E2B_BROWSER_TEMPLATE','E2B_WORKSPACE_TEMPLATE'])
        assert.throws(()=>createDefaultAdapters({...environment,[key]:'legacy-secret'}),/Split E2B templates are no longer supported/);
      assert.throws(()=>createDefaultAdapters({...environment,E2B_COMPUTER_TEMPLATE:undefined}),/configuration is incomplete/);
      if (${JSON.stringify(mode)}==='tenant') {
        assert.throws(()=>createDefaultAdapters({...environment,OTTO_COMPUTER_CONTROL_URL:'https://external.example.test'}),/shutdown configuration is invalid/);
        const hosted=createDefaultAdapters({...environment,OTTO_COMPUTER_CONTROL_URL:'http://otto.computer/v1/stopped',OTTO_RUNTIME_GENERATION:'999'});
        globalThis.fetch=async(_url,request)=>{assert.equal(request.headers['x-otto-generation'],'17');return Response.json({ok:true})};
        const fresh=createDefaultAdapters({...environment,OTTO_COMPUTER_CONTROL_URL:'http://otto.computer/v1/stopped',OTTO_RUNTIME_GENERATION:'999'});
        await fresh.confirmComputerShutdown();
        assert.equal(typeof hosted.confirmComputerShutdown,'function');
      }
      process.stdout.write('composition passed');
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          DOTENV_CONFIG_PATH: '/tmp/otto-synthetic-missing-env',
          OTTO_MODE: mode,
          OTTO_OWNER_ID: owner,
          OTTO_ENVIRONMENT: 'development',
          OTTO_RUNTIME_GENERATION: '17',
          OTTO_RUNTIME_SECRET: Buffer.alloc(32, 1).toString('base64url'),
          OTTO_VAULT_KEY: Buffer.alloc(32, 2).toString('base64'),
          OTTO_DATA_ROOT: '/tmp/otto-synthetic-composition',
          DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
          PGBOSS_SCHEMA: 'sk_jobs_' + 'a'.repeat(32),
        },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'composition passed');
  }
});
