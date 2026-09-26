import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const failure of ['none', 'application', 'database'] as const) {
  test(`server shutdown drains the database after ${failure} cleanup failure`, () => {
    const server = new URL('../src/server/', import.meta.url).href;
    const script = `
      import { registerHooks } from 'node:module';
      const modules = new Map([
        [${JSON.stringify(server + 'db.ts')}, "export const pool={end:async()=>{process.stdout.write('database-closed');if(process.env.CLOSE_FAILURE==='database')throw new Error('synthetic-private-failure')}}"],
        [${JSON.stringify(server + 'config.ts')}, 'export const port=4310'],
        [${JSON.stringify(server + 'composition.ts')}, "export const createDefaultAdapters=()=>({});export const createApplication=async()=>({app:{register:async()=>{},setNotFoundHandler:()=>{},listen:async()=>{setImmediate(()=>{process.emit('SIGTERM');process.emit('SIGINT')})},close:async()=>{process.stdout.write('application-closed');if(process.env.CLOSE_FAILURE==='application')throw new Error('synthetic-private-failure')}}})"],
      ]);
      registerHooks({load(url, context, next){
        const source=modules.get(url);
        return source===undefined?next(url,context):{format:'module',source,shortCircuit:true};
      }});
      await import(${JSON.stringify(server + 'index.ts')});
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: 'production', CLOSE_FAILURE: failure },
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, failure === 'none' ? 0 : 1, child.stderr);
    assert.equal(child.stdout.match(/application-closed/g)?.length, 1);
    assert.equal(child.stdout.match(/database-closed/g)?.length, 1);
    assert.doesNotMatch(child.stderr, /synthetic-private-failure|UnhandledPromise/);
  });
}
