import assert from 'node:assert/strict';
import test from 'node:test';
import { completedStreamLimit, initialStreamState, streamReducer } from '../src/web/lib/streams.ts';

test('concurrent task streams and consecutive messages retain independent text', () => {
  let state = streamReducer(initialStreamState, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'a-1',
    text: 'First ',
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-b',
    streamId: 'b-1',
    text: 'Another task',
  });
  state = streamReducer(state, { type: 'delta', taskId: 'task-a', streamId: 'a-1', text: 'reply' });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'a-2',
    text: 'New reply prefix',
  });
  state = streamReducer(state, { type: 'persisted', streamIds: ['a-1'] });
  assert.deepEqual(state.active, {
    'b-1': { taskId: 'task-b', text: 'Another task' },
    'a-2': { taskId: 'task-a', text: 'New reply prefix' },
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'a-2',
    text: ' stays',
  });
  assert.equal(state.active['a-2'].text, 'New reply prefix stays');
});

test('explicit completion closes transient tool prose without erasing a subsequent stream', () => {
  let state = streamReducer(initialStreamState, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'prose',
    text: 'Inspecting the page',
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'answer',
    text: 'Found it',
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'prose',
    text: '',
    done: true,
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'prose',
    text: 'late text',
  });
  assert.equal(state.active.prose, undefined);
  assert.equal(state.active.answer.text, 'Found it');
  assert.ok(state.completed.includes('prose'));
});

test('persisted and completed stream IDs cannot be resurrected by late deltas or stale refreshes', () => {
  let state = streamReducer(initialStreamState, { type: 'persisted', streamIds: ['saved'] });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'ended',
    text: '',
    done: true,
  });
  state = streamReducer(state, { type: 'persisted', streamIds: [] });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'saved',
    text: 'late',
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'ended',
    text: 'late',
  });
  assert.deepEqual(state.active, {});
  assert.deepEqual(state.completed, ['saved', 'ended']);
});

test('completion history stays bounded and stream IDs cannot cross task ownership', () => {
  let state = streamReducer(initialStreamState, {
    type: 'persisted',
    streamIds: Array.from({ length: completedStreamLimit + 10 }, (_, index) => `closed-${index}`),
  });
  assert.equal(state.completed.length, completedStreamLimit);
  assert.equal(state.completed[0], 'closed-10');
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'shared',
    text: 'Original',
  });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-b',
    streamId: 'shared',
    text: 'Wrong task',
  });
  assert.deepEqual(state.active.shared, { taskId: 'task-a', text: 'Original' });
});

test('reconnecting discards incomplete transient text but retains completed IDs', () => {
  let state = streamReducer(initialStreamState, { type: 'persisted', streamIds: ['saved'] });
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'task-a',
    streamId: 'transient',
    text: 'Partial tool prose',
  });
  state = streamReducer(state, { type: 'reset' });
  assert.deepEqual(state.active, {});
  assert.deepEqual(state.completed, ['saved']);
});

test('conversation resets fence old deltas and state while allowing the new onboarding stream', () => {
  let state = streamReducer(initialStreamState, {
    type: 'delta',
    taskId: 'old',
    streamId: 'old-stream',
    text: 'Archived',
    conversationRevision: 2,
  });
  state = streamReducer(state, { type: 'conversation', conversationRevision: 3 });
  assert.deepEqual(state.active, {});
  for (const action of [
    {
      type: 'delta' as const,
      taskId: 'old',
      streamId: 'old-stream',
      text: 'Late',
      conversationRevision: 2,
    },
    { type: 'persisted' as const, streamIds: ['future-stream'], conversationRevision: 2 },
    { type: 'conversation' as const, conversationRevision: 1 },
  ])
    state = streamReducer(state, action);
  assert.deepEqual(state.active, {});
  assert.deepEqual(state.completed, []);
  state = streamReducer(state, {
    type: 'delta',
    taskId: 'new',
    streamId: 'future-stream',
    text: 'Welcome',
    conversationRevision: 3,
  });
  assert.equal(state.active['future-stream'].text, 'Welcome');
  assert.equal(state.conversationRevision, 3);
});
