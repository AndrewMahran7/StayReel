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
  
  /** Route queued by a notification tap that arrived before auth was ready. */
  pendingNotificationRoute: string | null;

  /** Job ID from a snapshot-complete notification tap, consumed by dashboard reconciliation. */
  pendingNotificationJobId: string | null;

  /** Whether the user has accepted the current Terms of Service version. */
  termsAccepted:  boolean;

  setSession:      (session: Session | null) => void;
  setInitialised:  () => void;
  setIgAccountId:  (id: string | null) => void;
  setPendingListType: (type: string | null) => void;
  setPendingNotificationRoute: (route: string | null) => void;
  setPendingNotificationJobId: (id: string | null) => void;
  setTermsAccepted: (accepted: boolean) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  session:         null,
  user:            null,
  initialised:     false,
  igAccountId:     null,
  pendingListType: null,
  pendingNotificationRoute: null,
  pendingNotificationJobId: null,
  termsAccepted:   false,

  setSession: (session) =>
    set({ session, user: session?.user ?? null }),

  setInitialised: () =>
    set({ initialised: true }),

  setIgAccountId: (id) =>
    set({ igAccountId: id }),

  setPendingListType: (type) =>
    set({ pendingListType: type }),

  setPendingNotificationRoute: (route) =>
    set({ pendingNotificationRoute: route }),

  setPendingNotificationJobId: (id) =>
    set({ pendingNotificationJobId: id }),

  setTermsAccepted: (accepted) =>
    set({ termsAccepted: accepted }),
}));
