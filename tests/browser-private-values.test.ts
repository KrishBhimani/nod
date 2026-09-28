import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';

test('split-code observations hide each private input value and retain unrelated numbers and refs', async () => {
  const directory = await mkdtemp('/tmp/otto-private-values-');
  const dom = new JSDOM(
    '<form class="otp"><h1>Verification</h1>' +
      Array.from(
        { length: 6 },
        (_, index) => `<input class="otp-input" aria-label="Digit ${index + 1}" maxlength="1">`,
      ).join('') +
      '<button type="button">Verify</button></form><p>Invoice 2026, 18 items</p><form><input aria-label="Seats" value="18"></form>',
    { url: 'https://1.1.1.1/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rect = new dom.window.DOMRect(0, 0, 30, 30);
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  const inputs = [...dom.window.document.querySelectorAll('input')];
  inputs[0].focus();
  const snapshots: string[] = [];
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: async (_executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      let data: Record<string, unknown> = {};
      if (command[0] === 'get' && command[1] === 'url') data = { url: dom.window.location.href };
      if (command[0] === 'eval') data = { result: await dom.window.eval(options?.input ?? '') };
      if (command[0] === 'snapshot') {
        const snapshot = [
          ...inputs.map(
            (input, index) =>
              `- textbox "${input.getAttribute('aria-label')}" [ref=e${index + 1}]: ${input.value}`,
          ),
          '- button "Verify" [ref=e8]',
        ].join('\n');
        snapshots.push(snapshot);
        data = { snapshot };
      }
      if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic masked frame');
      return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: dom.window.location.href });
    const inspection = await computer.inspectLogin('fixture');
    const otp = inspection.fields.find((field) => field.kind === 'otp')!;
    assert.ok(otp);
    await computer.injectCredentials({
      taskId: 'fixture',
      origin: dom.window.location.origin,
      kind: 'otp',
      code: '483729',
      passwordSelector: otp.selector,
    });
    const observation = await computer.act('fixture', { action: 'snapshot' });
    assert.match(snapshots.at(-1)!, /textbox "Digit 1" \[ref=e1\]: 4/);
    assert.match(observation.text, /Invoice 2026, 18 items/);
    assert.match(observation.text, /textbox "Seats" \[ref=e7\]: 18/);
    for (let index = 0; index < 6; index++) {
      assert.ok(
        observation.text.includes(`textbox "Digit ${index + 1}" [ref=e${index + 1}]: [redacted]`),
      );
      assert.equal(inputs[index].style.color, 'transparent');
    }
    assert.deepEqual(observation.candidates, [{ id: '@e8', label: '- button "Verify" [ref=e8]' }]);
    assert.equal(observation.text.includes('483729'), false);
  } finally {
    await computer.dispose();
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
