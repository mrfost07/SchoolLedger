type SessionListener = () => void;

interface SessionStoreState {
  accessToken: string | null;
  listeners: Set<SessionListener>;
}

declare global {
  var __spSessionStore: SessionStoreState | undefined;
}

const state: SessionStoreState = (globalThis.__spSessionStore ??= {
  accessToken: null,
  listeners: new Set<SessionListener>(),
});

export const sessionStore = {
  get(): string | null {
    return state.accessToken;
  },
  set(token: string | null): void {
    state.accessToken = token;
    for (const listener of state.listeners) listener();
  },
  subscribe(listener: SessionListener): () => void {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  },
};
