import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';

test(
  'native interrupted credential feedback refuses submission and a fresh browser remains usable',
  { skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE, timeout: 60_000 },
  async () => {
    let submissions = 0;
    const server = createServer((request, response) => {
      if (request.url === '/submitted') {
        submissions++;
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><title>Synthetic login</title><body>
        <form onsubmit="event.preventDefault();fetch('/submitted',{method:'POST'});document.querySelector('#status').textContent='Entry received'">
          <label for="password">Password</label><input id="password" type="password">
          <button id="submit">Sign in</button>
        </form>
        <p id="status">Waiting</p>
        <button type="button" onclick="document.querySelector('#status').textContent='Fresh action completed'">Fresh action</button>
        </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), 'otto-credential-transition-'));
    let interrupted = 0;
    let feedbackCalls = 0;
    let closeCalls = 0;
    let clicks = 0;
    const computer = createAgentBrowserComputer({
      dataRoot: root,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
      daemonCommand: async (path, command, signal, timeoutMs, maxBytes) => {
        if (command.action === 'close') closeCalls++;
        if (command.action === 'click') clicks++;
        if (
          command.action === 'evaluate' &&
          typeof command.script === 'string' &&
          command.script.includes('mark=false;') &&
          command.script.includes('data-otto-entry-attempt')
        ) {
          feedbackCalls++;
          try {
            return await existingDaemonCommand(
              path,
              {
                ...command,
                script: `new Promise(resolve => setTimeout(() => resolve(${command.script}), 3000))`,
              },
              signal,
              timeoutMs,
              maxBytes,
            );
          } catch (error) {
            if (signal?.aborted) interrupted++;
            throw error;
          }
        }
        return existingDaemonCommand(path, command, signal, timeoutMs, maxBytes);
      },
    });
    try {
      await computer.act('credential-transition', { action: 'open', url: origin });
      const submission = await computer
        .injectCredentials({
          threadId: 'credential-transition',
          origin,
          kind: 'password',
          password: 'synthetic-credential-must-stay-private',
          passwordSelector: '#password',
          submitSelector: '#submit',
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      assert.equal(feedbackCalls, 1);
      assert.equal(interrupted, 1);
      assert.equal(closeCalls, 1);
      assert.equal(submissions, 1);
      await assert.rejects(
        computer.act('credential-transition', { action: 'snapshot' }),
        /The browser session has expired/,
      );
      assert.equal(clicks, 0);
      const fresh = await computer.act('credential-fresh-retry', {
        action: 'open',
        url: origin,
      });
      const button = fresh.candidates.find((candidate) => candidate.label.includes('Fresh action'));
      assert.ok(button);
      const clicked = await computer.act('credential-fresh-retry', {
        action: 'click',
        selector: button.id,
      });
      assert.match(clicked.text, /Fresh action completed/);
      assert.equal(clicks, 1);
      assert.equal(submissions, 1);
      assert.equal(clicked.text.includes('synthetic-credential-must-stay-private'), false);
      assert.equal(submission.value, undefined);
      assert.ok(submission.error instanceof Error);
      assert.equal(
        submission.error.message,
        'Secure entry could not be confirmed. Check the login page before continuing.',
      );
    } finally {
      try {
        await computer.dispose();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
