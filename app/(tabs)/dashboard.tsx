// app/(tabs)/dashboard.tsx
// Dashboard: daily snapshot button with countdown, stats, growth chart.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useDashboard }                                          from '@/hooks/useDashboard';
import { useSnapshotCapture, SnapshotLimitError, SnapshotError } from '@/hooks/useSnapshotCapture';
import { useNetwork }                            from '@/hooks/useNetwork';
import { DashboardCard }                       from '@/components/DashboardCard';
import { StatsRow }                            from '@/components/StatsRow';
import { WeeklySummaryCard }                   from '@/components/WeeklySummaryCard';
import { StreakBadge }                         from '@/components/StreakBadge';
import { GrowthChart }                         from '@/components/GrowthChart';
import { SnapshotErrorCard }                   from '@/components/SnapshotErrorCard';
import { PaywallModal }                        from '@/components/PaywallModal';
import { SchoolPickerModal }                   from '@/components/SchoolPickerModal';
import { useAuthStore }                        from '@/store/authStore';
import { useSubscriptionStore }                from '@/store/subscriptionStore';
import { useSchoolPrompt }                     from '@/hooks/useSchoolPrompt';
import { isBetaActive }                        from '@/lib/betaAccess';
import C                                       from '@/lib/colors';
import type { ListType }                       from '@/hooks/useListData';
import { TapTheDotGameModal }                  from '@/components/TapTheDotGameModal';
import { recordSuccessfulSnapshot }            from '@/hooks/useReviewPrompt';
import { trackEvent }                          from '@/lib/analytics';
import { reconcile }                           from '@/hooks/useSnapshotReconciliation';
import { SnapshotStatusCard }                   from '@/components/SnapshotStatusCard';
import { HowItWorksModal }                     from '@/components/HowItWorksModal';
import { supabase }                            from '@/lib/supabase';
import { useAutoSnapshotSetting }               from '@/hooks/useAutoSnapshotSetting';

// Ã¢â€â‚¬Ã¢â€â‚¬ Countdown hook Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function useCountdown(targetIso: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!targetIso) { setLabel(null); return; }

    const tick = () => {
      const ms = new Date(targetIso).getTime() - Date.now();
      if (ms <= 0) { setLabel(null); return; }
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000);
      setLabel(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
      );
    };

    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [targetIso]);

  return label;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Card definitions Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const CARDS: {
  key:       ListType;
  title:     string;
  icon:      any;
  iconColor: string;
  bgColor:   string;
}[] = [
  { key: 'new_followers',        title: 'New followers',          icon: 'person-add',           iconColor: C.green,  bgColor: C.greenDim  },
  { key: 'lost_followers',       title: 'Unfollowed you',         icon: 'person-remove',         iconColor: C.red,    bgColor: C.redDim    },
  { key: 'not_following_back',   title: 'Not following you back', icon: 'arrow-back-circle',    iconColor: C.amber,  bgColor: C.amberDim  },
  { key: 'you_dont_follow_back', title: "You don't follow back",  icon: 'arrow-forward-circle', iconColor: C.teal,   bgColor: C.tealDim   },
  { key: 'you_unfollowed',       title: 'You unfollowed',         icon: 'close-circle',          iconColor: C.accent, bgColor: C.accentDim },
];

/** Snapshot error codes that require Instagram reconnection before retrying. */
const RECONNECT_CODES = new Set([
  'CHALLENGE_REQUIRED',
  'CHECKPOINT_REQUIRED',
  'IG_CHALLENGE_REQUIRED',
  'SESSION_EXPIRED',
  'IG_SESSION_INVALID',
]);

// Ã¢â€â‚¬Ã¢â€â‚¬ Screen Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export default function DashboardScreen() {
  const router                                 = useRouter();
  const { data, isLoading, refetch, error } = useDashboard();
  const capture                                = useSnapshotCapture();
  const { isOffline }                          = useNetwork();
  const [capturing, setCapturing]              = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const setPendingListType                     = useAuthStore((s) => s.setPendingListType);
  const user                                   = useAuthStore((s) => s.user);
  const igAccountId                            = useAuthStore((s) => s.igAccountId);
  const pendingNotificationJobId               = useAuthStore((s) => s.pendingNotificationJobId);

  // Subscription (freemium: snapshots always allowed, lists gated)
  const isPro               = useSubscriptionStore((s) => s.isPro);
  const incrementFreeUsage  = useSubscriptionStore((s) => s.incrementFreeUsage);
  const [paywallOpen, setPaywallOpen] = useState(false);

  // School attribution prompt (shown once for new users)
  const schoolPrompt = useSchoolPrompt();

  // Auto-snapshot setting
  const autoSnapshotSetting = useAutoSnapshotSetting();

  // "How It Works" modal
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  // Track last app open for auto-snapshot eligibility
  useEffect(() => {
    if (user?.id) {
      supabase.from('profiles').update({
        last_app_open_at: new Date().toISOString(),
      }).eq('id', user.id).then(() => {});
    }
  }, [user?.id]);

  // Track beta access messaging (once per mount)
  const betaTrackedRef = useRef(false);
  useEffect(() => {
    if (isBetaActive() && !betaTrackedRef.current) {
      betaTrackedRef.current = true;
      trackEvent('beta_access_shown', { screen: 'dashboard' });
    }
  }, []);

  // "Tap the Dot" game modal
  const [gameOpen,       setGameOpen]       = useState(false);
  // snapshot completion state for game modal feedback
  const [snapshotDone,   setSnapshotDone]   = useState(false);
  const [snapshotErr,    setSnapshotErr]    = useState<string | null>(null);
  // track previous capturing so we detect the transition
  const wasCapturingRef = useRef(false);

  // â”€â”€ Reconciliation state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // "Completed while away" banner (auto-dismisses after 5 s)
  const [completedWhileAway, setCompletedWhileAway] = useState(false);
  // Guard against duplicate reconciliation runs
  const isReconciling = useRef(false);
  // Track AppState for foreground transitions
  const appStateRef = useRef(AppState.currentState);
  // Gate: don't show stale error UI until initial reconciliation has run.
  // This prevents a flash of a poll-failure error card before reconciliation
  // has a chance to clear/replace it with the real server state.
  const [reconciliationDone, setReconciliationDone] = useState(false);

  // next_allowed_at: prefer live API value, updated on rate-limit error
  const [overrideNextAt, setOverrideNextAt]    = useState<string | null>(null);
  const nextAllowedAt  = overrideNextAt ?? data?.next_snapshot_allowed_at ?? null;
  const countdown      = useCountdown(nextAllowedAt);
  const isLimited      = countdown !== null;

  // â”€â”€ Staged progress narrative â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Maps real job phase data to a 4-stage human-readable flow.
  // Every label is truthful â€” no stage claims completion before its time.
  const stage = (() => {
    const p = capture.progress;
    // Queued state: job is waiting for a concurrency slot â€” show an
    // honest "waiting" stage instead of pretending to scan.
    if (p.queued) {
      return {
        step:     1,
        label:    'Queued',
        headline: 'Waiting for an available slot\u2026',
        subtitle: p.queueMessage ?? 'We\u2019ll start your snapshot automatically',
        pct: 0.01,
      };
    }
    if (!p.phase) {
      const isResuming = p.resumed;
      return {
        step:     1,
        label:    isResuming ? 'Resuming'           : 'Connecting',
        headline: isResuming ? 'Resuming snapshot\u2026' : 'Connecting to Instagram\u2026',
        subtitle: isResuming
          ? 'Carrying on from where your last scan paused'
          : 'Establishing a secure session',
        pct: 0.02,
      };
    }
    if (p.phase === 'followers') {
      const detail = p.followerCountApi > 0
        ? `${p.followersSeen.toLocaleString()} of ~${p.followerCountApi.toLocaleString()} followers`
        : `${p.followersSeen.toLocaleString()} followers so far`;
      const pct = p.followerCountApi > 0 ? Math.min(0.55, (p.followersSeen / p.followerCountApi) * 0.55) : 0.15;
      const subtitle = p.isFirstSnapshot
        ? `${detail} \u00b7 First snapshots take a bit longer`
        : p.etaLabel ? `${detail} \u00b7 ${p.etaLabel}` : detail;
      return { step: 2, label: 'Scanning',  headline: 'Scanning your followers\u2026',  subtitle, pct: Math.max(0.05, pct) };
    }
    if (p.phase === 'following') {
      const detail = p.followingCached ? 'Using cached following list \u2713' : `${p.followingSeen.toLocaleString()} following so far`;
      const subtitle = p.isFirstSnapshot
        ? `${detail} \u00b7 First snapshots take a bit longer`
        : p.etaLabel ? `${detail} \u00b7 ${p.etaLabel}` : detail;
      return { step: 3, label: 'Comparing', headline: 'Comparing relationships\u2026', subtitle, pct: p.followingCached ? 0.85 : 0.65 };
    }
    // finalize
    return { step: 4, label: 'Building', headline: 'Building your report\u2026', subtitle: 'Almost there\u2026', pct: 0.95 };
  })();

  // When the last error requires reconnection, gate the snapshot button.
  const needsReconnect = capture.error instanceof SnapshotError && RECONNECT_CODES.has(capture.error.code);

  // Clear override once the server confirms it's gone
  useEffect(() => {
    if (data?.next_snapshot_allowed_at === null) setOverrideNextAt(null);
  }, [data?.next_snapshot_allowed_at]);

  // The tab navigator keeps this screen alive across sign-out â†’ sign-in,
  // so capture.error can persist from a previous session.
  // useSnapshotCapture already clears the error when igAccountId changes,
  // which covers the cross-session case. We intentionally do NOT clear
  // the error on every focus event â€” that would race with reconciliation
  // and erase errors the user needs to see.

  // â”€â”€ Reconciliation: backend is source of truth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // On mount, foreground resume, or notification tap, check the server
  // for the real job state and act accordingly.
  //
  // LIFECYCLE ORDERING (cold-start from notification):
  //   1. _layout.tsx mounts â†’ useNotifications runs
  //   2. getLastNotificationResponseAsync() fires (async Promise)
  //   3. AuthGuard routes to dashboard â†’ mount effect fires
  //   4. Step 2 may or may not have resolved by step 3 â€” so we absorb
  //      the notification jobId from the store at reconciliation entry
  //      rather than relying on React effect ordering.
  //   5. If the Promise resolves while reconciliation is in-flight, the
  //      drain check after the mutex release picks it up.
  const runReconciliation = useCallback(async (targetJobId?: string) => {
    if (!igAccountId || isReconciling.current) {
      console.log('[dashboard] Reconciliation skipped â€”',
        !igAccountId ? 'no igAccountId' : 'already in progress');
      return;
    }

    // Absorb any pending notification jobId from the store. This avoids
    // timing races with the async getLastNotificationResponseAsync() call
    // and the React effect that watches pendingNotificationJobId.
    if (!targetJobId) {
      const storeState = useAuthStore.getState();
      if (storeState.pendingNotificationJobId) {
        targetJobId = storeState.pendingNotificationJobId;
        storeState.setPendingNotificationJobId(null);
        console.log('[dashboard] Reconciliation: absorbed notification jobId from store:', targetJobId);
      }
    }

    isReconciling.current = true;
    try {
      console.log('[dashboard] Reconciliation: start', targetJobId ? `(jobId: ${targetJobId})` : '(latest)');
      const action = await reconcile(igAccountId, capture.isPending, targetJobId);
      console.log('[dashboard] Reconciliation: result â†’', action.type);

      switch (action.type) {
        case 'completed_while_away':
          capture.clearError();
          setCompletedWhileAway(true);
          setTimeout(() => setCompletedWhileAway(false), 6_000);
          break;

        case 'still_running':
        case 'still_queued':
          // Server says the job is still active. Auto-resume the
          // polling loop by calling mutateAsync, which will detect the
          // existing running job via snapshot-start.
          console.log('[dashboard] Reconciliation: auto-resuming job', action.jobId);
          capture.clearError();
          capture.mutateAsync().catch((err) => {
            // The job likely completed between the reconciliation check
            // and the startJob call â€” server returns a rate-limit error
            // for the "new" snapshot since last_snapshot_at was just set.
            // Clear the stale capture error and refresh dashboard data
            // to reflect the completed job.
            console.log('[dashboard] Auto-resume failed:', (err as Error).message, 'â€” clearing error & refetching');
            capture.clearError();
            refetch();
          });
          break;

        case 'failed':
          console.log('[dashboard] Reconciliation: job failed â€” code:', action.failureCode, '| msg:', action.error);
          capture.setExternalError(
            new SnapshotError(action.failureCode, action.error),
          );
          break;

        case 'stale_cleared':
          capture.clearError();
          refetch();
          break;

        case 'none':
        default:
          break;
      }
    } catch (err) {
      console.warn('[dashboard] Reconciliation error:', (err as Error).message);
    } finally {
      isReconciling.current = false;
      if (!reconciliationDone) setReconciliationDone(true);
    }

    // DRAIN: if a notification tap arrived while the mutex was held
    // (e.g. getLastNotificationResponseAsync resolved mid-reconcile),
    // process it now. Safe from infinite recursion because the drain
    // clears the jobId before re-entering.
    const drainJobId = useAuthStore.getState().pendingNotificationJobId;
    if (drainJobId) {
      console.log('[dashboard] Reconciliation drain: processing queued notification jobId:', drainJobId);
      useAuthStore.getState().setPendingNotificationJobId(null);
      return runReconciliation(drainJobId);
    }
  }, [igAccountId, capture.isPending, capture, refetch, reconciliationDone]);

  // Mount: run reconciliation. Any pending notification jobId is absorbed
  // inside runReconciliation (reads from store directly).
  useEffect(() => {
    runReconciliation();
  }, [igAccountId]);

  // Foreground resume: run reconciliation on background â†’ active transition.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prevState !== 'active') {
        console.log(`[dashboard] App foregrounded (${prevState} â†’ ${nextState})`);
        runReconciliation();
      }
    });
    return () => sub.remove();
  }, [runReconciliation]);

  // Warm-start notification tap: useNotifications sets the jobId in the
  // store while the app is already running. This effect triggers
  // reconciliation â€” the jobId is absorbed from the store inside
  // runReconciliation, not consumed here, so nothing is lost if the
  // mutex is held.
  useEffect(() => {
    if (pendingNotificationJobId) {
      console.log('[dashboard] Notification jobId detected:', pendingNotificationJobId);
      runReconciliation();
    }
  }, [pendingNotificationJobId, runReconciliation]);

  // Detect snapshot finish â†’ update modal feedback flags
  useEffect(() => {
    const isNowCapturing = capturing || capture.isPending;
    if (wasCapturingRef.current && !isNowCapturing) {
      // capture just finished
      if (capture.error) {
        setSnapshotErr(capture.error.message ?? 'Snapshot failed.');
      } else {
        setSnapshotDone(true);
      }
    }
    wasCapturingRef.current = isNowCapturing;
  }, [capturing, capture.isPending, capture.error]);

  const handleRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await refetch();
    } finally {
      setManualRefreshing(false);
    }
  }, [refetch]);

  const handleCapture = async () => {
    if (isLimited) return;

    // Paywall gate removed â€” freemium model allows unlimited snapshots.
    // Lists are gated instead.

    await new Promise<void>((resolve) =>
      Alert.alert(
        'This takes a few minutes',
        "We fetch your followers slowly on purpose â€” it keeps your Instagram account safe.\n\nNote: Instagram may occasionally ask you to re-verify your account during or after a snapshot. This is normal and doesn't mean anything is wrong.\n\nWhile you wait, play Tap the Dot! ðŸ™",
        [{ text: 'Got it, let\'s go!', onPress: () => resolve() }],
        { cancelable: false },
      )
    );

    setCapturing(true);
    setSnapshotDone(false);
    setSnapshotErr(null);
    trackEvent('snapshot_started', { is_pro: isPro });
    try {
      await capture.mutateAsync();
      setOverrideNextAt(null);

      // Track free snapshot usage for analytics (no-op for pro users)
      if (!isPro) {
        incrementFreeUsage().catch(() => {});
      }

      // Record successful snapshot for review-prompt eligibility
      // (the actual prompt fires from lists.tsx when the user views results)
      recordSuccessfulSnapshot();

      trackEvent('snapshot_completed', { is_pro: isPro });
    } catch (err: any) {
      trackEvent('snapshot_failed', {
        is_pro: isPro,
        error:  err?.message ?? 'unknown',
        is_rate_limit: err instanceof SnapshotLimitError,
      });
      if (err instanceof SnapshotLimitError) {
        setOverrideNextAt(err.nextAllowedAt);
      }
      // All other errors: capture.error is already set by the hook and
      // shown inline via SnapshotErrorCard â€” no Alert needed.
    } finally {
      setCapturing(false);
    }
  };

  const getCount = (key: ListType): number => {
    if (!data) return 0;
    const map: Record<ListType, number> = {
      new_followers:        data.new_followers_count        ?? 0,
      lost_followers:       data.lost_followers_count       ?? 0,
      not_following_back:   data.not_following_back_count   ?? 0,
      you_dont_follow_back: data.you_dont_follow_back_count ?? 0,
      you_unfollowed:       data.you_unfollowed_count       ?? 0,
    };
    return map[key] ?? 0;
  };

  return (
    <SafeAreaView style={styles.safe}>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={manualRefreshing}
            onRefresh={handleRefresh}
            tintColor={C.accent}
            enabled={!isOffline}
          />
        }
      >
        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Header Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {/* Offline banner */}
        {isOffline && data && (
          <View style={styles.offlineBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={C.amber} />
            <Text style={styles.offlineBannerText}>
              You're offline. Showing your last snapshot.
            </Text>
          </View>
        )}

        {/* "Completed while away" success banner */}
        {completedWhileAway && (
          <View style={styles.completedAwayBanner}>
            <Ionicons name="checkmark-circle" size={16} color={C.green} />
            <Text style={styles.completedAwayText}>
              Snapshot finished while you were away â€” results updated!
            </Text>
          </View>
        )}

        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.greeting}>Dashboard</Text>
            {data?.to_captured_at && (
              <Text style={styles.subtitle}>
                Last capture{' '}
                {new Date(data.to_captured_at).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </Text>
            )}
          </View>

          {/* Daily Snapshot button / countdown */}
          <TouchableOpacity
            style={[
              styles.captureBtn,
              (capturing || isLimited || isOffline || needsReconnect) && styles.captureBtnDisabled,
            ]}
            onPress={handleCapture}
            disabled={capturing || capture.isPending || isLimited || isOffline || needsReconnect}
          >
            {capturing || capture.isPending ? (
              <>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.captureBtnText}>{stage.label}\u2026</Text>
              </>
            ) : needsReconnect ? (
              <>
                <Ionicons name="shield-outline" size={16} color="#fff" />
                <Text style={styles.captureBtnText}>Reconnect Required</Text>
              </>
            ) : isLimited ? (
              <>
                <Ionicons name="time-outline" size={16} color="#fff" />
                <Text style={styles.captureBtnText}>{countdown}</Text>
              </>
            ) : (
              <>
                <Ionicons name="camera-outline" size={16} color="#fff" />
                <Text style={styles.captureBtnText}>Take Snapshot</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Safety info text */}
        <Text style={styles.infoText}>
          {needsReconnect
            ? 'Reconnect your Instagram account to take another snapshot.'
            : isLimited && data?.cooldown_reason === 'daily_cap'
            ? `Daily limit reached (${data?.snapshots_today ?? 3} of 3 today). Resets in ${countdown}.`
            : isLimited
            ? `Next snapshot available in ${countdown}.`
            : 'Up to 3 snapshots per day, 1 per hour â€” keeps your account safe.'}
        </Text>

        {/* â”€â”€ Snapshot status card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data && !capturing && !capture.isPending && (
          <SnapshotStatusCard
            lastSnapshotAt={data.to_captured_at ?? null}
            snapshotsToday={data.snapshots_today ?? 0}
            dailyCap={3}
            autoSnapshotEnabled={autoSnapshotSetting.enabled}
            isCapturing={false}
          />
        )}

        {/* â”€â”€ Snapshot progress card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {(capturing || capture.isPending) && (
          <View style={styles.progressCard}>
            {/* keep-open warning */}
            <View style={styles.keepOpenRow}>
              <Ionicons name="shield-checkmark-outline" size={15} color={C.teal} style={{ marginRight: 6 }} />
              <Text style={styles.keepOpenText}>
                {capture.progress.resumed
                  ? 'Resuming your snapshot from where it paused. '
                  : 'Scanning slowly to protect your Instagram account. '}
                You can switch apps â€” your progress is saved. Instagram may occasionally ask you to re-verify; this is normal.
              </Text>
            </View>

            {/* Step indicators â€” 4 dots showing which stage we're on */}
            <View style={styles.stepsRow}>
              {(capture.progress.resumed
                ? ['Resuming', 'Scanning', 'Comparing', 'Building']
                : ['Connecting', 'Scanning', 'Comparing', 'Building']
              ).map((lbl, i) => {
                const stepNum = i + 1;
                const done    = stage.step > stepNum;
                const active  = stage.step === stepNum;
                return (
                  <View key={lbl} style={styles.stepItem}>
                    <View style={[
                      styles.stepDot,
                      done   && styles.stepDotDone,
                      active && styles.stepDotActive,
                    ]}>
                      {done ? (
                        <Ionicons name="checkmark" size={10} color="#fff" />
                      ) : (
                        <Text style={[
                          styles.stepDotText,
                          active && styles.stepDotTextActive,
                        ]}>{stepNum}</Text>
                      )}
                    </View>
                    <Text style={[
                      styles.stepLabel,
                      (done || active) && styles.stepLabelActive,
                    ]}>{lbl}</Text>
                  </View>
                );
              })}
            </View>

            {/* Narrative headline + real data subtitle */}
            <View style={styles.progressBanner}>
              <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.progressTitle}>{stage.headline}</Text>
                <Text style={styles.progressSub}>{stage.subtitle}</Text>
              </View>
            </View>

            {/* Visual progress bar */}
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${Math.round(stage.pct * 100)}%` }]} />
            </View>

            {/* Live confirmed "doesn't follow back" count â€” only visible once
                followers phase is fully done and following scan has begun.
                Stays hidden during followers phase â€” no speculative results. */}
            {capture.progress.partialResultsReady && !capture.progress.queued && (
              <View style={styles.partialNfbRow}>
                <Ionicons
                  name="person-outline"
                  size={15}
                  color={C.accent}
                  style={{ marginRight: 8 }}
                />
                <Text style={styles.partialNfbText}>
                  {capture.progress.partialNotFollowingBackCount > 0
                    ? `Found ${capture.progress.partialNotFollowingBackCount} ${
                        capture.progress.partialNotFollowingBackCount === 1 ? 'person' : 'people'
                      } who ${
                        capture.progress.partialNotFollowingBackCount === 1 ? "doesn\u2019t" : "don\u2019t"
                      } follow you back so far`
                    : 'Scanning who doesn\u2019t follow you back\u2026'}
                </Text>
              </View>
            )}

            {/* cached following note */}
            {capture.progress.followingCached && (
              <View style={styles.cachedFollowingRow}>
                <Ionicons name="shield-checkmark-outline" size={14} color={C.teal} style={{ marginRight: 6 }} />
                <Text style={styles.cachedFollowingText}>
                  Using your following list from earlier today â€” refreshed once daily to keep your account safe.
                </Text>
              </View>
            )}

            {/* play mini-game CTA */}
            <TouchableOpacity
              style={styles.playGameBtn}
              onPress={() => setGameOpen(true)}
              activeOpacity={0.8}
            >
              <View style={styles.playGameBtnInner}>
                <Ionicons name="game-controller" size={18} color="#fff" style={{ marginRight: 8 }} />
                <View>
                  <Text style={styles.playGameTitle}>Play while loading</Text>
                  <Text style={styles.playGameSub}>Tap the Dot mini-game</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.6)" style={{ marginLeft: 'auto' }} />
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* â”€â”€ Game modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <TapTheDotGameModal
          visible={gameOpen}
          onClose={() => setGameOpen(false)}
          snapshotRunning={capturing || capture.isPending}
          snapshotDone={snapshotDone}
          snapshotError={snapshotErr}
        />

        {/* Snapshot capture error â€” gated behind initial reconciliation
             so we never flash a stale poll error before the server state
             has been checked and applied. */}
        {reconciliationDone && capture.error && (
          <SnapshotErrorCard
            error={capture.error}
            onDismiss={capture.clearError}
          />
        )}

        {/* Dashboard load error */}
        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={C.red} />
            <Text style={styles.errorText}>{error.message}</Text>
          </View>
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Loading Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {isLoading && !data && (
          <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Streak badge Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {data && (data.current_streak_days ?? 0) > 0 && (
          <StreakBadge
            currentStreak={data.current_streak_days}
            longestStreak={data.longest_streak_days}
          />
        )}

        {/* â”€â”€ Net follower change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data?.net_follower_change != null && data.has_diff && (
          <View style={[
            styles.netCard,
            data.net_follower_change >= 0 ? styles.netPositive : styles.netNegative,
          ]}>
            <Text style={styles.netLabel}>Net follower change</Text>
            <Text style={styles.netValue}>
              {data.net_follower_change >= 0 ? '+' : ''}
              {data.net_follower_change.toLocaleString()}
            </Text>
            {(data.new_followers_count > 0 || data.lost_followers_count > 0) && (
              <Text style={styles.netExplain}>
                +{data.new_followers_count} new Â· âˆ’{data.lost_followers_count} lost
              </Text>
            )}
          </View>
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Stats row (followers / following / friends) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {data && (data.follower_count > 0 || data.following_count > 0) && (
          <StatsRow
            followerCount={data.follower_count  ?? 0}
            followingCount={data.following_count ?? 0}
            mutualCount={data.mutual_count       ?? 0}
          />
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Weekly summary Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {data?.has_weekly_summary && (
          <WeeklySummaryCard
            newFollowers={data.weekly_new_followers   ?? 0}
            lostFollowers={data.weekly_lost_followers ?? 0}
            netChange={data.weekly_net_change         ?? 0}
          />
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Growth chart Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {data && <GrowthChart />}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Diff metric cards Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {/* Contextual help */}
        {data && data.has_diff && (
          <View style={helpStyles.contextualHelpRow}>
            <Ionicons name="information-circle-outline" size={14} color={C.textMuted} />
            <Text style={helpStyles.contextualHelpText}>
              These lists compare your most recent snapshots. This is not a live Instagram feed.
            </Text>
          </View>
        )}

        {data && CARDS.map((card) => (
          <DashboardCard
            key={card.key}
            title={card.title}
            count={getCount(card.key)}
            icon={card.icon}
            iconColor={card.iconColor}
            bgColor={card.bgColor}
            onPress={() => {
              setPendingListType(card.key);
              router.push('/(tabs)/lists');
            }}
          />
        ))}

        {/* Beta access badge (replaces upgrade CTA during beta) */}
        {data && isBetaActive() && (
          <View style={styles.betaBanner}>
            <View style={styles.betaIconCircle}>
              <Ionicons name="star" size={16} color={C.accent} />
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.upgradeTitle}>Pro is free during beta</Text>
              <Text style={styles.upgradeSub}>
                Full access to all lists and features â€” enjoy!
              </Text>
            </View>
            <View style={styles.betaChip}>
              <Text style={styles.betaChipText}>BETA</Text>
            </View>
          </View>
        )}

        {/* Soft upgrade CTA for free users (hidden during beta) */}
        {data && !isPro && !isBetaActive() && (
          <TouchableOpacity
            style={styles.upgradeCta}
            onPress={() => setPaywallOpen(true)}
            activeOpacity={0.85}
          >
            <Ionicons name="lock-open-outline" size={18} color={C.accent} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.upgradeTitle}>Unlock full lists</Text>
              <Text style={styles.upgradeSub}>
                See all your ghost followers, new followers, and more with StayReel Pro
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
          </TouchableOpacity>
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ First-snapshot hint Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {data && !data.has_diff && (
          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={C.textMuted} />
            <Text style={styles.hintText}>
              Come back in an hour for your first snapshot comparison.
            </Text>
          </View>
        )}

        {/* Ã¢â€â‚¬Ã¢â€â‚¬ Empty state Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */}
        {!data && !isLoading && (
          <View style={styles.emptyState}>
            <Ionicons
              name={isOffline ? 'cloud-offline-outline' : 'analytics-outline'}
              size={48}
              color={C.textMuted}
            />
            <Text style={styles.emptyTitle}>
              {isOffline ? 'No saved data' : 'No data yet'}
            </Text>
            <Text style={styles.emptyBody}>
              {isOffline
                ? 'Connect to the internet to fetch your first snapshot.'
                : (
                  <>
                    Tap{' '}
                    <Text style={styles.emptyBold}>Take Snapshot</Text>
                    {' '}to capture your first snapshot and start tracking your growth.
                  </>
                )}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Paywall modal â€“ shown when free user taps upgrade CTA */}
      <PaywallModal visible={paywallOpen} onClose={() => setPaywallOpen(false)} />

      {/* School attribution modal â€“ shown once for new users */}
      <SchoolPickerModal
        visible={schoolPrompt.shouldShow}
        userId={user?.id ?? ''}
        onDone={schoolPrompt.dismiss}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.black },
  scroll: { padding: 16, paddingBottom: 32 },

  header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   4,
  },
  headerLeft: { flex: 1 },
  greeting: {
    color:      C.textPrimary,
    fontSize:   26,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    color:     C.textMuted,
    fontSize:  12,
    marginTop: 2,
  },

  captureBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               6,
    backgroundColor:   C.accent,
    borderRadius:      20,
    paddingVertical:   8,
    paddingHorizontal: 14,
    marginLeft:        8,
  },
  captureBtnDisabled: { opacity: 0.55 },
  captureBtnText: {
    color:      '#fff',
    fontSize:   12,
    fontWeight: '600',
  },

  infoText: {
    color:         C.textMuted,
    fontSize:      11,
    marginBottom:  14,
    marginTop:     2,
  },

  progressCard: {
    backgroundColor: C.surface,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     C.border,
    marginBottom:    14,
    overflow:        'hidden',
  },
  keepOpenRow: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    backgroundColor: C.amberDim,
    paddingVertical:  8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  keepOpenText: {
    color:      C.amber,
    fontSize:   12,
    flex:       1,
    lineHeight: 17,
  },
  progressBanner: {
    flexDirection: 'row',
    alignItems:    'center',
    padding:       14,
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
  },
  progressTitle: {
    color:      C.textPrimary,
    fontSize:   15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  progressSub: {
    color:      C.textSecondary,
    fontSize:   12,
    marginTop:  3,
  },

  progressBarBg: {
    height:           4,
    backgroundColor:  C.surfaceAlt,
    marginHorizontal: 12,
    marginBottom:     8,
    borderRadius:     2,
    overflow:         'hidden',
  },
  progressBarFill: {
    height:           '100%' as any,
    backgroundColor:  C.accent,
    borderRadius:     2,
  },

  cachedFollowingRow: {
    flexDirection:     'row',
    alignItems:        'flex-start',
    backgroundColor:   C.tealDim,
    paddingVertical:   8,
    paddingHorizontal: 12,
    borderTopWidth:    1,
    borderTopColor:    C.border,
  },
  cachedFollowingText: {
    color:      C.teal,
    fontSize:   12,
    flex:       1,
    lineHeight: 17,
  },

  // Step indicators
  stepsRow: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    paddingHorizontal: 16,
    paddingTop:        14,
    paddingBottom:     6,
  },
  stepItem: {
    alignItems: 'center',
    flex:       1,
  },
  stepDot: {
    width:           22,
    height:          22,
    borderRadius:    11,
    backgroundColor: C.surfaceAlt,
    borderWidth:     1,
    borderColor:     C.border,
    alignItems:      'center',
    justifyContent:  'center',
  },
  stepDotActive: {
    backgroundColor: C.accentDim,
    borderColor:     C.accent,
  },
  stepDotDone: {
    backgroundColor: C.accent,
    borderColor:     C.accent,
  },
  stepDotText: {
    color:      C.textMuted,
    fontSize:   10,
    fontWeight: '700',
  },
  stepDotTextActive: {
    color: C.accent,
  },
  stepLabel: {
    color:      C.textMuted,
    fontSize:   10,
    marginTop:  4,
  },
  stepLabelActive: {
    color:      C.textPrimary,
    fontWeight: '600',
  },

  playGameBtn: {
    backgroundColor: C.accent,
    margin:          12,
    marginTop:       8,
    borderRadius:    12,
    overflow:        'hidden',
    shadowColor:     C.accent,
    shadowOffset:    { width: 0, height: 3 },
    shadowOpacity:   0.3,
    shadowRadius:    6,
    elevation:       4,
  },
  playGameBtnInner: {
    flexDirection:   'row',
    alignItems:      'center',
    paddingVertical:  12,
    paddingHorizontal: 14,
  },
  playGameTitle: {
    color:      '#fff',
    fontSize:   14,
    fontWeight: '700',
  },
  playGameSub: {
    color:      'rgba(255,255,255,0.7)',
    fontSize:   11,
    marginTop:  1,
  },

  errorBox: {
    flexDirection:   'row',
    backgroundColor: C.redDim,
    borderRadius:    10,
    padding:         12,
    gap:             8,
    marginBottom:    12,
  },
  errorText: { color: C.red, fontSize: 13, flex: 1 },

  netCard: {
    borderRadius:   14,
    padding:        16,
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   14,
  },
  netPositive: { backgroundColor: C.greenDim },
  netNegative: { backgroundColor: C.redDim   },
  netLabel:    { color: C.textSecondary, fontSize: 14 },
  netValue:    { color: C.textPrimary, fontSize: 26, fontWeight: '800' },
  netExplain:  { color: C.textMuted, fontSize: 12, marginTop: 2 },

  hintBox: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    gap:             8,
    backgroundColor: C.surface,
    borderRadius:    10,
    padding:         12,
    marginTop:       4,
    marginBottom:    8,
  },
  hintText: { color: C.textMuted, fontSize: 13, flex: 1, lineHeight: 18 },

  emptyState: {
    alignItems: 'center',
    paddingTop:  44,
    gap:         12,
  },
  emptyTitle: {
    color:      C.textSecondary,
    fontSize:   18,
    fontWeight: '700',
  },
  emptyBody: {
    color:      C.textMuted,
    fontSize:   14,
    textAlign:  'center',
    lineHeight: 22,
    maxWidth:   260,
  },
  emptyBold: { color: C.textPrimary, fontWeight: '600' },

  offlineBanner: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             8,
    backgroundColor: C.amberDim,
    borderRadius:    10,
    padding:         10,
    marginBottom:    12,
  },
  offlineBannerText: {
    color:    C.amber,
    fontSize: 13,
    flex:     1,
  },

  completedAwayBanner: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             8,
    backgroundColor: C.greenDim,
    borderRadius:    10,
    padding:         10,
    marginBottom:    12,
  },
  completedAwayText: {
    color:    C.green,
    fontSize: 13,
    flex:     1,
  },

  upgradeCta: {
    flexDirection:    'row',
    alignItems:       'center',
    backgroundColor:  C.surface,
    borderRadius:     14,
    borderWidth:      1,
    borderColor:      C.border,
    padding:          14,
    marginBottom:     14,
  },
  upgradeTitle: {
    color:      C.textPrimary,
    fontSize:   15,
    fontWeight: '700',
  },
  upgradeSub: {
    color:      C.textMuted,
    fontSize:   12,
    marginTop:  2,
    lineHeight: 17,
  },

  betaBanner: {
    flexDirection:    'row',
    alignItems:       'center',
    backgroundColor:  C.surface,
    borderRadius:     14,
    borderWidth:      1,
    borderColor:      C.accentDim,
    padding:          14,
    marginBottom:     14,
  },
  betaIconCircle: {
    width:           34,
    height:          34,
    borderRadius:    17,
    backgroundColor: C.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
  },
  betaChip: {
    backgroundColor: C.accentDim,
    borderRadius:    8,
    paddingVertical:  3,
    paddingHorizontal: 8,
  },
  betaChipText: {
    color:        C.accent,
    fontSize:     10,
    fontWeight:   '700',
    letterSpacing: 0.8,
  },

  // Live partial "doesn't follow back" counter shown during following phase
  partialNfbRow: {
    flexDirection:    'row',
    alignItems:       'center',
    marginHorizontal: 12,
    marginTop:        6,
    marginBottom:     2,
    paddingVertical:   9,
    paddingHorizontal: 12,
    backgroundColor:  C.accentDim,
    borderRadius:     8,
  },
  partialNfbText: {
    color:      C.accentLight,
    fontSize:   13,
    flex:       1,
    lineHeight: 18,
  },
});



const helpStyles = StyleSheet.create({
  contextualHelpRow: {
    flexDirection:   'row' as const,
    alignItems:      'flex-start' as const,
    gap:             6,
    paddingVertical:  6,
    paddingHorizontal: 2,
    marginBottom:    8,
  },
  contextualHelpText: {
    color:      C.textMuted,
    fontSize:   11,
    flex:       1,
    lineHeight: 16,
  },
});