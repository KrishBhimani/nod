import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { runProcess } from '../src/providers/process.ts';

class Element {
  isConnected = true;
  disabled = false;
  readOnly = false;
  type = 'text';
  name = '';
  autocomplete = '';
  innerText = '';
  tagName = 'INPUT';
  attrs = new Map<string, string>();
  styles = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.styles.set(name, value) };
  stored = '';
  onInput = () => {};
  onClick = () => {};
  get value() {
    return this.stored;
  }
  set value(value: string) {
    this.stored = value;
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getClientRects() {
    return this.isConnected ? [{}] : [];
  }
  matches(selector: string) {
    return selector === 'input' && this.tagName === 'INPUT';
  }
  closest() {
    return null;
  }
  dispatchEvent() {
    this.onInput();
  }
  click() {
    this.onClick();
  }
}

export class LoginPage {
  stage: 'identifier' | 'password' | 'otp' | 'complete' = 'identifier';
  location = { origin: 'https://1.1.1.1', href: 'https://1.1.1.1/login' };
  input = new Element();
  next = new Element();
  google = new Element();
  passkey = new Element();
  verification = new Element();
  echo = new Element();
  entered: string[] = [];
  closed = false;
  constructor() {
    this.render();
  }
  render() {
    this.input.isConnected = false;
    this.input = new Element();
    this.input.name = this.stage;
    this.input.autocomplete =
      this.stage === 'identifier'
        ? 'username'
        : this.stage === 'otp'
          ? 'one-time-code'
          : 'current-password';
    this.input.type = this.stage === 'password' ? 'password' : 'text';
    this.next = new Element();
    this.next.tagName = 'BUTTON';
    this.next.innerText = 'Next';
    this.next.disabled = true;
    this.input.onInput = () => {
      setTimeout(() => {
        this.next.disabled = false;
      }, 5);
    };
    this.next.onClick = () => {
      this.entered.push(this.input.value);
      this.stage =
        this.stage === 'identifier' ? 'password' : this.stage === 'password' ? 'otp' : 'complete';
      this.echo.innerText = this.entered.join(' ');
      this.render();
    };
    this.google.tagName = 'BUTTON';
    this.google.innerText = 'Continue with Google';
    this.google.onClick = () => {
      this.location.origin = 'https://2.2.2.2';
      this.location.href = 'https://2.2.2.2/login';
    };
    this.passkey.tagName = 'BUTTON';
    this.passkey.innerText = 'Use a passkey';
    this.verification.tagName = 'BUTTON';
    this.verification.innerText = 'Get a code by email';
    this.verification.onClick = () => {
      this.stage = 'otp';
      this.render();
    };
    this.echo.tagName = 'DIV';
  }
  nodes(selector: string): Element[] {
    const inputs = this.stage === 'complete' ? [] : [this.input];
    const controls = [this.next, this.google, this.passkey, this.verification];
    if (selector === 'input' || selector === 'input,textarea') return inputs;
    if (selector === 'button,a,[role="button"],input[type="submit"]') return controls;
    if (selector.startsWith('input[type="password"],input[autocomplete='))
      return inputs.filter(
        (input) =>
          input.type === 'password' || ['one-time-code', 'username'].includes(input.autocomplete),
      );
    const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
    return match
      ? [...inputs, ...controls].filter((element) => element.getAttribute(match[1]) === match[2])
      : [];
  }
  text() {
    return `Sign in ${this.stage} ${this.echo.innerText}`;
  }
  screen() {
    return `Screen ${this.stage} ${this.echo.styles.get('color') === 'transparent' ? '[redacted]' : this.echo.innerText}`;
  }
  async evaluate(script: string) {
    const page = this;
    return runInNewContext(script, {
      location: this.location,
      document: {
        body: {
          get innerText() {
            return page.text();
          },
        },
        querySelectorAll: (selector: string) => this.nodes(selector),
        createTreeWalker: () => {
          let first = true;
          return {
            currentNode: { textContent: this.echo.innerText, parentElement: this.echo },
            nextNode: () => {
              const result = first;
              first = false;
              return result;
            },
          };
        },
      },
      HTMLInputElement: Element,
      NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      Event: class {},
      setTimeout,
    });
  }
}

export function stagedLoginBrowser() {
  const pages = new Map<string, LoginPage>();
  const run: typeof runProcess = async (_executable, args, options) => {
    const id = basename(args[args.indexOf('--profile') + 1]);
    let page = pages.get(id);
    if (!page) {
      page = new LoginPage();
      pages.set(id, page);
    }
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    let data: Record<string, unknown> = {};
    if (command[0] === 'get') {
      const node = command[1] === 'attr' ? page.nodes(command[2])[0] : undefined;
      data =
        command[1] === 'url'
          ? { url: page.location.href }
          : {
              value: node
                ? command[3] === 'type'
                  ? node.type
                  : command[3] === 'autocomplete'
                    ? node.autocomplete
                    : node.getAttribute(command[3])
                : null,
            };
    }
    if (command[0] === 'eval') data = { result: await page.evaluate(options?.input ?? '') };
    if (command[0] === 'snapshot') data = { snapshot: page.text() };
    if (command[0] === 'screenshot') await writeFile(command[1], page.screen());
    if (command[0] === 'close') page.closed = true;
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  return { run, pages };
}
