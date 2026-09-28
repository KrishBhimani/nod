import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Composio } from '@composio/core';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';

const slug = 'NOTION_GET_PAGE_MARKDOWN';
const inputSchema = {
  type: 'object',
  properties: { page_id: { type: 'string', description: 'x'.repeat(18_001) } },
  required: ['page_id'],
};

function reference(toolSlug = slug) {
  return {
    tool_slug: toolSlug,
    toolkit: 'notion',
    description: 'Read a page.',
    hasFullSchema: false,
    schemaRef: {
      tool: 'COMPOSIO_GET_TOOL_SCHEMAS',
      args: { tool_slugs: [toolSlug] },
    },
  };
}

async function fixture(t: TestContext) {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const transport = client.getClient().toolRouter.session;
  let tools: Record<string, unknown> = { [slug]: reference() };
  let metadata: unknown = {
    data: {
      success: true,
      tool_schemas: {
        [slug]: { tool_slug: slug, toolkit: 'notion', input_schema: inputSchema },
      },
    },
    error: null,
    log_id: 'private-metadata-log',
  };
  const metadataCalls: Array<{ id: string; input: unknown; options: unknown }> = [];
  t.mock.method(transport, 'create', async () => ({
    session_id: 'fixture-session',
    mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/mcp/fixture-session' },
    config: { user_id: 'fixture-owner' },
    config_version: 1,
  }));
  t.mock.method(transport, 'search', async (id: string) => {
    assert.equal(id, 'fixture-session');
    return {
      success: true,
      error: null,
      results: [
        {
          index: 0,
          use_case: 'Read a page',
          primary_tool_slugs: [slug],
          related_tool_slugs: [],
          toolkits: ['notion'],
        },
      ],
      tool_schemas: tools,
      toolkit_connection_statuses: [],
      next_steps_guidance: [],
      session: { id: 'private-search-session', generate_id: false, instructions: '' },
      time_info: {
        current_time_utc: '2026-09-28T00:00:00Z',
        current_time_utc_epoch_seconds: 1790553600,
        message: '',
      },
    };
  });
  t.mock.method(transport, 'executeMeta', async (id: string, input: unknown, options: unknown) => {
    metadataCalls.push({ id, input, options });
    if (metadata instanceof Error) throw metadata;
    return metadata;
  });
  t.mock.method(transport, 'execute', async () => {
    assert.fail('Schema discovery must not execute an application action.');
  });
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => {
    assert.fail('Schema discovery must remain in the existing session.');
  });
  return {
    session: await createComposioProvider({ client }).createSession('fixture-owner', {
      notion: 'fixture-account',
    }),
    metadataCalls,
    tools(value: Record<string, unknown>) {
      tools = value;
    },
    metadata(value: unknown) {
      metadata = value;
    },
  };
}

test('Composio discovery hydrates advertised schema references in the same session without truncation', async (t) => {
  const control = await fixture(t);
  const result = await control.session.search('Read a page');
  const tools = result.tools as Record<string, Record<string, unknown>>;
  assert.deepEqual(tools[slug].inputSchema, inputSchema);
  assert.equal(tools[slug].hasFullSchema, true);
  assert.equal('schemaRef' in tools[slug], false);
  assert.deepEqual(result.suggestions, [{ useCase: 'Read a page', primaryToolSlugs: [slug] }]);
  assert.equal(control.metadataCalls.length, 1);
  assert.equal(control.metadataCalls[0].id, 'fixture-session');
  assert.deepEqual(control.metadataCalls[0].input, {
    slug: 'COMPOSIO_GET_TOOL_SCHEMAS',
    arguments: { tool_slugs: [slug], include: ['input_schema'] },
  });
  const options = control.metadataCalls[0].options as {
    signal: AbortSignal;
    maxRetries: number;
  };
  assert.equal(options.maxRetries, 0);
  assert.equal(options.signal.aborted, false);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('Composio discovery preserves full schemas and does not fetch redundant references', async (t) => {
  const control = await fixture(t);
  control.tools({
    [slug]: { ...reference(), hasFullSchema: true, input_schema: inputSchema },
  });
  const result = await control.session.search('Read a page');
  const tools = result.tools as Record<string, Record<string, unknown>>;
  assert.deepEqual(tools[slug].inputSchema, inputSchema);
  assert.equal('schemaRef' in tools[slug], false);
  assert.deepEqual(control.metadataCalls, []);
});

test('Composio discovery accepts the uppercase toolkit identifiers returned by search', async (t) => {
  const control = await fixture(t);
  control.tools({ [slug]: { ...reference(), toolkit: 'NOTION' } });
  control.metadata({
    data: {
      success: true,
      tool_schemas: {
        [slug]: { tool_slug: slug, toolkit: 'NOTION', input_schema: inputSchema },
      },
    },
    error: null,
    log_id: 'private-log',
  });
  const result = await control.session.search('Read a page');
  const tools = result.tools as Record<string, Record<string, unknown>>;
  assert.equal(tools[slug].toolkit, 'notion');
  assert.deepEqual(tools[slug].inputSchema, inputSchema);
  assert.equal(control.metadataCalls.length, 1);
});

test('Composio discovery resolves a bounded shared reference list in one metadata request', async (t) => {
  const control = await fixture(t);
  const slugs = Array.from({ length: 20 }, (_, index) => `NOTION_FIXTURE_${index}`);
  control.tools(
    Object.fromEntries(
      slugs.map((current) => [
        current,
        {
          ...reference(current),
          schemaRef: { tool: 'COMPOSIO_GET_TOOL_SCHEMAS', args: { tool_slugs: slugs } },
        },
      ]),
    ),
  );
  control.metadata({
    data: {
      successful: true,
      error: null,
      data: {
        success: true,
        not_found: [],
        tool_schemas: Object.fromEntries(
          slugs.map((current) => [
            current,
            { tool_slug: current, toolkit: 'notion', input_schema: { type: 'object' } },
          ]),
        ),
      },
    },
    error: null,
    log_id: 'private-log',
  });
  const result = await control.session.search('Read page metadata');
  assert.equal(Object.keys(result.tools as object).length, 20);
  assert.equal(JSON.stringify(result).includes('schemaRef'), false);
  assert.equal(control.metadataCalls.length, 1);
  assert.deepEqual(control.metadataCalls[0].input, {
    slug: 'COMPOSIO_GET_TOOL_SCHEMAS',
    arguments: { tool_slugs: slugs, include: ['input_schema'] },
  });
});

test('Composio discovery refuses unadvertised or unsupported references before metadata access', async (t) => {
  const control = await fixture(t);
  const cases = [
    { [slug]: { ...reference(), toolkit: 'github' } },
    { [slug]: reference('NOTION_OTHER_TOOL') },
    {
      [slug]: {
        ...reference(),
        schemaRef: {
          tool: 'COMPOSIO_GET_TOOL_SCHEMAS',
          args: { tool_slugs: ['NOTION_OTHER_TOOL'] },
        },
      },
    },
    {
      [slug]: {
        ...reference(),
        schemaRef: { tool: 'COMPOSIO_GET_TOOL_SCHEMAS', args: { tool_slugs: [slug, slug] } },
      },
    },
    { [slug]: { ...reference(), schemaRef: undefined } },
    Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => {
        const current = `NOTION_FIXTURE_${index}`;
        return [current, reference(current)];
      }),
    ),
  ];
  for (const value of cases) {
    control.tools(value);
    await assert.rejects(control.session.search('Read a page'), {
      message: 'The app tool schemas could not be loaded.',
    });
  }
  assert.deepEqual(control.metadataCalls, []);
});

test('Composio discovery rejects incomplete, conflicting and failed metadata without retrying', async (t) => {
  const control = await fixture(t);
  const tool = { tool_slug: slug, toolkit: 'notion', input_schema: inputSchema };
  const body = { success: true, tool_schemas: { [slug]: tool } };
  const cases = [
    new Error('private-provider-error'),
    { data: body, error: 'private-provider-error', log_id: 'private-log' },
    { data: body, error: null, successful: false },
    { data: { successful: false, data: body }, error: null },
    { data: { successful: true, error: 'private-provider-error', data: body }, error: null },
    { data: { ...body, success: false }, error: null },
    { data: { ...body, successful: false }, error: null },
    { data: { ...body, error: 'private-provider-error' }, error: null },
    { data: { ...body, not_found: [slug] }, error: null },
    { data: { success: true, tool_schemas: {} }, error: null },
    {
      data: { ...body, tool_schemas: { ...body.tool_schemas, NOTION_OTHER_TOOL: tool } },
      error: null,
    },
    {
      data: { ...body, tool_schemas: { [slug]: { ...tool, tool_slug: 'NOTION_OTHER_TOOL' } } },
      error: null,
    },
    { data: { ...body, tool_schemas: { [slug]: { ...tool, toolkit: 'slack' } } }, error: null },
    {
      data: { ...body, tool_schemas: { [slug]: { ...tool, input_schema: undefined } } },
      error: null,
    },
  ];
  for (const [index, value] of cases.entries()) {
    control.metadata(value);
    await assert.rejects(control.session.search('Read a page'), {
      message: 'The app tool schemas could not be loaded.',
    });
    assert.equal(control.metadataCalls.length, index + 1);
  }
});
