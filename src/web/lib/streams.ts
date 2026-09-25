export interface StreamState {
  conversationRevision: number;
  active: Record<string, { taskId: string; text: string }>;
  completed: string[];
}

export type StreamAction =
  | {
      type: 'delta';
      taskId: string;
      text: string;
      streamId?: string;
      done?: boolean;
      conversationRevision?: number;
    }
  | { type: 'persisted'; streamIds: string[]; conversationRevision?: number }
  | { type: 'reset' }
  | { type: 'conversation'; conversationRevision: number };

export const initialStreamState: StreamState = {
  conversationRevision: 0,
  active: {},
  completed: [],
};
export const completedStreamLimit = 512;

function closeStreams(state: StreamState, ids: string[]): StreamState {
  if (!ids.length) return state;
  const closed = new Set(ids);
  const completed = [...state.completed.filter((id) => !closed.has(id)), ...closed].slice(
    -completedStreamLimit,
  );
  const active = Object.fromEntries(Object.entries(state.active).filter(([id]) => !closed.has(id)));
  return { ...state, active, completed };
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  if (action.type === 'reset') return { ...state, active: {} };
  const revision = action.conversationRevision ?? state.conversationRevision;
  if (revision < state.conversationRevision) return state;
  if (revision > state.conversationRevision)
    state = { conversationRevision: revision, active: {}, completed: [] };
  if (action.type === 'conversation') return state;
  if (action.type === 'persisted') return closeStreams(state, action.streamIds);
  const id = action.streamId || `task:${action.taskId}`;
  if (action.done) return closeStreams(state, [id]);
  if (!action.text || state.completed.includes(id)) return state;
  const current = state.active[id];
  if (current && current.taskId !== action.taskId) return state;
  return {
    ...state,
    active: {
      ...state.active,
      [id]: { taskId: action.taskId, text: (current?.text ?? '') + action.text },
    },
  };
}
