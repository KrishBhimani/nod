export interface StreamState {
  active: Record<string, { taskId: string; text: string }>;
  completed: string[];
}

export type StreamAction =
  | { type: 'delta'; taskId: string; text: string; streamId?: string; done?: boolean }
  | { type: 'persisted'; streamIds: string[] }
  | { type: 'reset' };

export const initialStreamState: StreamState = { active: {}, completed: [] };
export const completedStreamLimit = 512;

function closeStreams(state: StreamState, ids: string[]): StreamState {
  if (!ids.length) return state;
  const closed = new Set(ids);
  const completed = [...state.completed.filter((id) => !closed.has(id)), ...closed].slice(
    -completedStreamLimit,
  );
  const active = Object.fromEntries(Object.entries(state.active).filter(([id]) => !closed.has(id)));
  return { active, completed };
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  if (action.type === 'reset') return { ...state, active: {} };
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
