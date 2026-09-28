import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageText } from '../src/web/components/message.tsx';
import { messageSetupLinks, safeMessageLink, setupLink } from '../src/web/lib/message-links.ts';

const origin = 'http://localhost:4310';
const render = (text: string) => renderToStaticMarkup(createElement(MessageText, { text }));

test('Apps links use the app route without obsolete aliases', () => {
  for (const path of ['/apps', `${origin}/apps`])
    assert.deepEqual(safeMessageLink(path, origin), { href: '/apps', kind: 'navigation' });
  assert.equal(safeMessageLink('/connections', origin), null);
  assert.equal(safeMessageLink(`${origin}/connections`, origin), null);
  assert.equal(safeMessageLink('/apps/unknown', origin), null);
  const connect = '/apps?connect=7f455e58-c202-4401-bb22-0a4e853a3ef5';
  assert.deepEqual(safeMessageLink(connect, origin), {
    href: connect,
    kind: 'setup',
    setup: 'app',
  });
  assert.equal(safeMessageLink('/apps?connect=bad', origin), null);
  assert.equal(safeMessageLink(`${connect}&next=https://example.com`, origin), null);
  assert.equal(safeMessageLink(`${connect}#token`, origin), null);
});

test('markdown artifact links show the filename without markdown punctuation', () => {
  const path = '/api/artifacts/cf047140-c98b-496b-96e2-365472458734';
  const result = render(`Title: Example Domain. Artifact: [browser-check.txt](${path})`);
  assert.match(
    result,
    new RegExp(
      `Artifact: <a href="${path}" target="_blank" rel="noopener noreferrer">browser-check.txt</a>`,
    ),
  );
});

test('setup links use one kind with fixed labels and omit tokens and fragments', () => {
  const link = safeMessageLink(
    '/credentials/request-id?token=private-token#private-fragment',
    origin,
  )!;
  assert.deepEqual(link, { href: '/credentials/request-id', kind: 'setup', setup: 'vault' });
  assert.deepEqual(setupLink(link, 'Sign in'), {
    href: '/credentials/request-id',
    setup: 'vault',
    label: 'Sign in',
  });
  assert.equal(setupLink(link, 'Click here for a prize')!.label, 'Vault');
  assert.equal(setupLink(link, 'Connect website')!.label, 'Vault');
  const website = safeMessageLink(`/browser-connect/${'a'.repeat(43)}`, origin)!;
  assert.deepEqual(website, {
    href: `/browser-connect/${'a'.repeat(43)}`,
    kind: 'setup',
    setup: 'website',
  });
  assert.equal(setupLink(website, 'Continue sign-in')!.label, 'Continue sign-in');
  assert.equal(setupLink(website, 'Add login')!.label, 'Connect website');
  const app = safeMessageLink('/apps?connect=7f455e58-c202-4401-bb22-0a4e853a3ef5', origin)!;
  assert.equal(setupLink(app, 'Connect GitHub')!.label, 'Connect GitHub');
  assert.equal(setupLink(app, 'Open this now')!.label, 'Connect app');
  assert.equal(safeMessageLink('/approvals/action-id', origin), null);
  assert.equal(safeMessageLink(`${origin}/approvals/action-id`, origin), null);
});

test('only HTTPS app sign-in links outside Otto use the setup action', () => {
  const oauth = safeMessageLink(
    'https://accounts.example.com/o/oauth2/auth?state=fixture',
    origin,
  )!;
  assert.deepEqual(setupLink(oauth, 'Connect Gmail'), {
    href: 'https://accounts.example.com/o/oauth2/auth?state=fixture',
    setup: 'app',
    label: 'Connect Gmail',
  });
  assert.equal(setupLink(oauth, 'Read the docs'), null);
  assert.equal(setupLink(oauth, 'Connect <b>now</b>'), null);
  assert.equal(
    setupLink(safeMessageLink('http://accounts.example.com/', origin)!, 'Connect Gmail'),
    null,
  );
  assert.equal(setupLink(safeMessageLink('/apps', origin)!, 'Connect Gmail'), null);
  assert.equal(
    setupLink(safeMessageLink('/api/artifacts/file-id', origin)!, 'Connect Gmail'),
    null,
  );
});

test('only intended app paths and credential-free HTTP URLs become links', () => {
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert',
    'data:text/html,test',
    'file:///etc/passwd',
    'mailto:hello@example.com',
    '//evil.example/api/artifacts/id',
    '/api/vault',
    '/api/artifacts/',
    '/api/artifacts/id/extra',
    '/api/artifacts/id/../../credentials/request',
    '/api/artifacts/%2e%2e/credentials/request',
    '/api/artifacts/id%2f..%2fvault',
    'http://localhost:4310/api/vault',
    'http://localhost:4310/api/artifacts/id/../../credentials/request',
    'https://user:password@example.com/',
    'https://example.com/\njavascript:alert',
    'https:\\evil.example',
    'https://example.com/"onclick="alert',
  ])
    assert.equal(safeMessageLink(value, origin), null, value);
  assert.deepEqual(safeMessageLink('https://example.com/docs?q=otto#usage', origin), {
    href: 'https://example.com/docs?q=otto#usage',
    kind: 'external',
  });
  assert.deepEqual(safeMessageLink('/api/artifacts/file-id', origin), {
    href: '/api/artifacts/file-id',
    kind: 'artifact',
  });
  const result = render(
    '//evil.example/api/artifacts/id file:///credentials/id javascript:/approvals/id',
  );
  assert.doesNotMatch(result, /<a /);
});

test('chat keeps setup phrases in the text and groups the actions at the end', () => {
  const result = render(
    [
      '[Add login](/vault/private-link?token=hidden#fragment),',
      `[Connect website](/browser-connect/${'b'.repeat(43)}),`,
      '[Connect GitHub](/apps?connect=7f455e58-c202-4401-bb22-0a4e853a3ef5) and',
      '[Connect Gmail](https://accounts.example.com/auth).',
      'Read the [docs](https://example.com/docs).',
    ].join(' '),
  );
  const [text, group] = result.split('<div class="setup-group">');
  assert.equal((text.match(/<strong class="setup-phrase">/g) ?? []).length, 4);
  assert.match(text, /<strong class="setup-phrase">Add login<\/strong>,/);
  assert.match(
    text,
    /<a href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/,
  );
  assert.equal((text.match(/<a /g) ?? []).length, 1);
  assert.equal((group.match(/<a /g) ?? []).length, 4);
  for (const setup of ['vault', 'website', 'app'])
    assert.match(group, new RegExp(`data-setup="${setup}"`));
  assert.match(group, /href="\/vault\/private-link" target="_blank"/);
  assert.match(group, /href="\/apps\?connect=7f455e58-c202-4401-bb22-0a4e853a3ef5" rel=/);
  assert.match(group, /title="accounts.example.com">.*Connect Gmail<\/a>/);
  assert.doesNotMatch(result, /token=hidden|#fragment/);
});

test('setup actions are listed once per destination', () => {
  assert.deepEqual(
    messageSetupLinks(
      '[Add login](/vault/one) again [Add login](/vault/one?token=x) and /credentials/two. [Docs](https://example.com)',
      origin,
    ),
    [
      { href: '/vault/one', setup: 'vault', label: 'Add login' },
      { href: '/credentials/two', setup: 'vault', label: 'Vault' },
    ],
  );
});

test('plain Vault request paths use the canonical label', () => {
  const result = render('See /vault/private-link?token=hidden#fragment.');
  assert.match(result, /See <strong class="setup-phrase">Vault<\/strong>\./);
  assert.match(result, /href="\/vault\/private-link"/);
  assert.doesNotMatch(result, /token=hidden|#fragment/);
});
