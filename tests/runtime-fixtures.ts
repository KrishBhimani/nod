import type { Computer, Workspace } from '../src/ports/computer.ts';

const syntheticReads = new Set([
  'GMAIL_FETCH_EMAILS',
  'GMAIL_GET_ATTACHMENT',
  'GMAIL_LIST_LABELS',
  'LINEAR_LIST_PROJECTS',
  'NOTION_FETCH_DATABASE',
  'NOTION_RETRIEVE_PAGE',
  'NOTION_SEARCH_NOTION_PAGE',
  'SLACK_SEARCH_MESSAGES',
]);

export async function fixtureReadOnly(action: string) {
  return syntheticReads.has(action);
}

export function fakeComputer(overrides: Partial<Computer> = {}): Computer {
  return {
    act: async () => ({ text: 'Fixture page', url: 'https://example.com', candidates: [] }),
    screenshot: async () => null,
    injectCredentials: async () => {},
    inspectLogin: async () => ({
      origin: 'https://example.com',
      url: 'https://example.com',
      fields: [],
      methods: [],
    }),
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'fixture computer',
    ...overrides,
  };
}

export function fakeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    open: () => ({
      path: '/fixture/workspace',
      instructions: 'Fixture workspace only.',
      exec: async () => ({ exitCode: 0 }),
    }),
    status: () => 'fixture workspace',
    dispose: () => {},
    ...overrides,
  };
}
