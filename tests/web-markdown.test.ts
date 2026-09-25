import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageText } from '../src/web/components/message.tsx';

function render(text: string) {
  return renderToStaticMarkup(createElement(MessageText, { text }));
}

test('chat renders Markdown, tables, static HTML and secure local links', () => {
  const result = render(
    '**Ready**\n\n- One\n- Two\n\n| Item | Count |\n| --- | --- |\n| Notes | 2 |\n\n<strong>HTML works</strong>\n\n/credentials/example-token',
  );
  assert.match(result, /<strong>Ready<\/strong>/);
  assert.match(result, /<ul>/);
  assert.match(result, /<table>/);
  assert.match(result, /<strong>HTML works<\/strong>/);
  assert.match(result, /href="\/credentials\/example-token"/);
  assert.match(result, />Vault/);
});

test('secure chat links keep action labels while hiding raw request tokens', () => {
  const result = render(
    '[Add login](/vault/add-token) [Enter verification code](/vault/otp-token) [sensitive-token](/vault/hidden-token)',
  );
  assert.match(result, />Add login<svg/);
  assert.match(result, />Enter verification code<svg/);
  assert.doesNotMatch(result, />sensitive-token</);
  assert.match(result, /class="credential-link"/);
});

test('chat HTML cannot run scripts, submit forms, load trackers or link to local internals', () => {
  const result = render(
    '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><form action="/api/messages"><input name="text" value="bad"></form><img src="https://evil.example/track" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="/api/state">internal</a>\n\n![picture](https://evil.example/pixel)',
  );
  for (const expression of [
    /<script/i,
    /<style/i,
    /<iframe/i,
    /<form/i,
    /onerror=/i,
    /src="https:\/\/evil/,
    /href="javascript:/i,
    /href="\/api\/state"/,
  ])
    assert.doesNotMatch(result, expression);
  assert.match(result, /type="checkbox"[^>]*disabled=""/);
});

test('code examples stay literal and artifact images are allowed', () => {
  const result = render(
    '```html\n<strong>example</strong>\n```\n\n![report](/api/artifacts/12345678-1234-1234-1234-123456789abc)',
  );
  assert.match(result, /&lt;strong&gt;example&lt;\/strong&gt;/);
  assert.match(result, /src="\/api\/artifacts\/12345678-1234-1234-1234-123456789abc"/);
});
