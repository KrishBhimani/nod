import type { Computer, Workspace } from '../src/ports/computer.ts';

const syntheticReads = new Set([
  'GMAIL_FETCH_EMAILS',
  'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  'GMAIL_GET_ATTACHMENT',
  'GMAIL_GET_DRAFT',
  'GMAIL_LIST_DRAFTS',
  'GMAIL_LIST_LABELS',
  'GOOGLECALENDAR_EVENTS_LIST',
  'GOOGLEDRIVE_DOWNLOAD_FILE',
  'GOOGLEDRIVE_FIND_FILE',
  'GOOGLESHEETS_BATCH_GET',
  'GOOGLESHEETS_GET_SPREADSHEET_INFO',
  'GOOGLESHEETS_SEARCH_SPREADSHEETS',
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
