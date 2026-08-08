import { create } from "zustand";
import { authApi } from "./rpc";

interface AuthState {
  /** unknown=尚未探测；authed / anon */
  status: "unknown" | "authed" | "anon";
  actorId?: string;
  probe: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: "unknown",
  actorId: undefined,
  probe: async () => {
    try {
      const r = await authApi.status();
      set({ status: "authed", actorId: r?.actor_id });
    } catch {
      set({ status: "anon", actorId: undefined });
    }
  },
  login: async (password: string) => {
    await authApi.login(password);
    const r = await authApi.status();
    set({ status: "authed", actorId: r?.actor_id });
  },
  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({ status: "anon", actorId: undefined });
    }
  },
}));
