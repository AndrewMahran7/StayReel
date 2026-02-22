// store/authStore.ts
// Lightweight Zustand store that mirrors the Supabase auth session.
// The root layout subscribes to onAuthStateChange and keeps this in sync.

import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';

interface AuthState {
  session:         Session | null;
  user:            User   | null;
  initialised:     boolean;
  igAccountId:     string | null;   // set after /connect-instagram succeeds
  pendingListType: string | null;   // set by Dashboard card tap to force-select list tab
  setSession:      (session: Session | null) => void;
  setInitialised:  () => void;
  setIgAccountId:  (id: string | null) => void;
  setPendingListType: (type: string | null) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  session:         null,
  user:            null,
  initialised:     false,
  igAccountId:     null,
  pendingListType: null,

  setSession: (session) =>
    set({ session, user: session?.user ?? null }),

  setInitialised: () =>
    set({ initialised: true }),

  setIgAccountId: (id) =>
    set({ igAccountId: id }),

  setPendingListType: (type) =>
    set({ pendingListType: type }),
}));
