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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useDashboard }                                          from '@/hooks/useDashboard';
import { useSnapshotCapture, SnapshotLimitError } from '@/hooks/useSnapshotCapture';
import { DashboardCard }                       from '@/components/DashboardCard';
import { BannerAdView }                        from '@/components/BannerAdView';
import { StatsRow }                            from '@/components/StatsRow';
import { WeeklySummaryCard }                   from '@/components/WeeklySummaryCard';
import { StreakBadge }                         from '@/components/StreakBadge';
import { GrowthChart }                         from '@/components/GrowthChart';
import { SnapshotErrorCard }                   from '@/components/SnapshotErrorCard';
import { PaywallModal }                        from '@/components/PaywallModal';
import { SchoolPickerModal }                   from '@/components/SchoolPickerModal';
import { ReferralCodeModal }                   from '@/components/ReferralCodeModal';
import { useAuthStore }                        from '@/store/authStore';
import { useSubscriptionStore }                from '@/store/subscriptionStore';
import { useSchoolPrompt }                     from '@/hooks/useSchoolPrompt';
import { useReferralPrompt }                   from '@/hooks/useReferralPrompt';
import C                                       from '@/lib/colors';
import type { ListType }                       from '@/hooks/useListData';
import { TapTheDotGameModal }                  from '@/components/TapTheDotGameModal';
import { recordSuccessfulSnapshot }            from '@/hooks/useReviewPrompt';
import { trackEvent }                          from '@/lib/analytics';

// â”€â”€ Countdown hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Card definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function DashboardScreen() {
  const router                                 = useRouter();
  const { data, isLoading, refetch, error } = useDashboard();
  const capture                                = useSnapshotCapture();
  const [capturing, setCapturing]              = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const setPendingListType                     = useAuthStore((s) => s.setPendingListType);
  const user                                   = useAuthStore((s) => s.user);

  // Subscription (freemium: snapshots always allowed, lists gated)
  const isPro               = useSubscriptionStore((s) => s.isPro);
  const incrementFreeUsage  = useSubscriptionStore((s) => s.incrementFreeUsage);
  const [paywallOpen, setPaywallOpen] = useState(false);

  // School attribution prompt (shown once for new users)
  const schoolPrompt = useSchoolPrompt();

  // Referral / ambassador code prompt (shown once, after school prompt)
  const referralPrompt = useReferralPrompt();
  // Only show referral modal when school prompt is NOT showing (avoids stacking)
  const showReferralModal = referralPrompt.shouldShow && !schoolPrompt.shouldShow;

  // "Tap the Dot" game modal
  const [gameOpen,       setGameOpen]       = useState(false);
  // snapshot completion state for game modal feedback
  const [snapshotDone,   setSnapshotDone]   = useState(false);
  const [snapshotErr,    setSnapshotErr]    = useState<string | null>(null);
  // track previous capturing so we detect the transition
  const wasCapturingRef = useRef(false);

  // next_allowed_at: prefer live API value, updated on rate-limit error
  const [overrideNextAt, setOverrideNextAt]    = useState<string | null>(null);
  const nextAllowedAt  = overrideNextAt ?? data?.next_snapshot_allowed_at ?? null;
  const countdown      = useCountdown(nextAllowedAt);
  const isLimited      = countdown !== null;

  // ── Staged progress narrative ─────────────────────────────────
  // Maps real job phase data to a 4-stage human-readable flow.
  // Every label is truthful — no stage claims completion before its time.
  const stage = (() => {
    const p = capture.progress;
    if (!p.phase) return { step: 1, label: 'Connecting',   headline: 'Connecting to Instagram\u2026',   subtitle: 'Establishing a secure session',                                                         pct: 0.02 };
    if (p.phase === 'followers') {
      const detail = p.followerCountApi > 0
        ? `${p.followersSeen.toLocaleString()} of ~${p.followerCountApi.toLocaleString()} followers`
        : `${p.followersSeen.toLocaleString()} followers so far`;
      const pct = p.followerCountApi > 0 ? Math.min(0.55, (p.followersSeen / p.followerCountApi) * 0.55) : 0.15;
      return { step: 2, label: 'Scanning',     headline: 'Scanning your followers\u2026',     subtitle: detail,                                                                                       pct: Math.max(0.05, pct) };
    }
    if (p.phase === 'following') {
      const detail = p.followingCached ? 'Using cached following list \u2713' : `${p.followingSeen.toLocaleString()} following so far`;
      return { step: 3, label: 'Comparing',    headline: 'Comparing relationships\u2026',    subtitle: detail,                                                                                       pct: p.followingCached ? 0.85 : 0.65 };
    }
    // finalize
    return { step: 4, label: 'Building',    headline: 'Building your report\u2026',       subtitle: 'Crunching the numbers',                                                                     pct: 0.95 };
  })();

  // Clear override once the server confirms it's gone
  useEffect(() => {
    if (data?.next_snapshot_allowed_at === null) setOverrideNextAt(null);
  }, [data?.next_snapshot_allowed_at]);

  // The tab navigator keeps this screen alive across sign-out → sign-in,
  // so capture.error can persist from a previous session. Clear it whenever
  // the screen comes back into focus so a returning user never sees a stale
  // error card from a session that has since been replaced.
  useFocusEffect(
    useCallback(() => {
      capture.clearError();
    }, []),
  );

  // Detect snapshot finish → update modal feedback flags
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

    // Paywall gate removed — freemium model allows unlimited snapshots.
    // Lists are gated instead.

    await new Promise<void>((resolve) =>
      Alert.alert(
        'This takes a few minutes ⏳',
        "We fetch your followers slowly on purpose — it keeps your Instagram account safe.\n\nWhile you wait, play Tap the Dot! We genuinely appreciate your patience. 🙏",
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
      // shown inline via SnapshotErrorCard — no Alert needed.
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
      <BannerAdView />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={manualRefreshing}
            onRefresh={handleRefresh}
            tintColor={C.accent}
          />
        }
      >
        {/* â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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
              (capturing || isLimited) && styles.captureBtnDisabled,
            ]}
            onPress={handleCapture}
            disabled={capturing || capture.isPending || isLimited}
          >
            {capturing || capture.isPending ? (
              <>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.captureBtnText}>{stage.label}\u2026</Text>
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
          {isLimited && data?.cooldown_reason === 'daily_cap'
            ? `Daily limit reached (${data?.snapshots_today ?? 3} of 3 today). Resets in ${countdown}.`
            : isLimited
            ? `Next snapshot available in ${countdown}.`
            : 'Up to 3 snapshots per day, 1 per hour — keeps your account safe.'}
        </Text>

        {/* ── Snapshot progress card ────────────────────────────────── */}
        {(capturing || capture.isPending) && (
          <View style={styles.progressCard}>
            {/* keep-open warning */}
            <View style={styles.keepOpenRow}>
              <Ionicons name="information-circle" size={15} color={C.amber} style={{ marginRight: 6 }} />
              <Text style={styles.keepOpenText}>
                Keep StayReel open while we refresh — if you leave it will pause.
              </Text>
            </View>

            {/* Step indicators — 4 dots showing which stage we're on */}
            <View style={styles.stepsRow}>
              {(['Connecting', 'Scanning', 'Comparing', 'Building'] as const).map((lbl, i) => {
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

            {/* cached following note */}
            {capture.progress.followingCached && (
              <View style={styles.cachedFollowingRow}>
                <Ionicons name="shield-checkmark-outline" size={14} color={C.teal} style={{ marginRight: 6 }} />
                <Text style={styles.cachedFollowingText}>
                  Using your following list from earlier today — refreshed once daily to keep your account safe.
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

        {/* ── Game modal ─────────────────────────────────────────────── */}
        <TapTheDotGameModal
          visible={gameOpen}
          onClose={() => setGameOpen(false)}
          snapshotRunning={capturing || capture.isPending}
          snapshotDone={snapshotDone}
          snapshotError={snapshotErr}
        />

        {/* Snapshot capture error */}
        {capture.error && (
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

        {/* â”€â”€ Loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {isLoading && !data && (
          <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
        )}

        {/* â”€â”€ Streak badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data && (data.current_streak_days ?? 0) > 0 && (
          <StreakBadge
            currentStreak={data.current_streak_days}
            longestStreak={data.longest_streak_days}
          />
        )}

        {/* ── Net follower change ────────────────────────────── */}
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
                +{data.new_followers_count} new · −{data.lost_followers_count} lost
              </Text>
            )}
          </View>
        )}

        {/* â”€â”€ Stats row (followers / following / friends) â”€â”€â”€â”€â”€â”€ */}
        {data && (data.follower_count > 0 || data.following_count > 0) && (
          <StatsRow
            followerCount={data.follower_count  ?? 0}
            followingCount={data.following_count ?? 0}
            mutualCount={data.mutual_count       ?? 0}
          />
        )}

        {/* â”€â”€ Weekly summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data?.has_weekly_summary && (
          <WeeklySummaryCard
            newFollowers={data.weekly_new_followers   ?? 0}
            lostFollowers={data.weekly_lost_followers ?? 0}
            netChange={data.weekly_net_change         ?? 0}
          />
        )}

        {/* â”€â”€ Growth chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data && <GrowthChart />}

        {/* â”€â”€ Diff metric cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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

        {/* Soft upgrade CTA for free users */}
        {data && !isPro && (
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

        {/* â”€â”€ First-snapshot hint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data && !data.has_diff && (
          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={C.textMuted} />
            <Text style={styles.hintText}>
              Come back in an hour for your first snapshot comparison.
            </Text>
          </View>
        )}

        {/* â”€â”€ Empty state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {!data && !isLoading && (
          <View style={styles.emptyState}>
            <Ionicons name="analytics-outline" size={48} color={C.textMuted} />
            <Text style={styles.emptyTitle}>No data yet</Text>
            <Text style={styles.emptyBody}>
              Tap{' '}
              <Text style={styles.emptyBold}>Take Snapshot</Text>
              {' '}to capture your first snapshot and start tracking your growth.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Paywall modal – shown when free user taps upgrade CTA */}
      <PaywallModal visible={paywallOpen} onClose={() => setPaywallOpen(false)} />

      {/* School attribution modal – shown once for new users */}
      <SchoolPickerModal
        visible={schoolPrompt.shouldShow}
        userId={user?.id ?? ''}
        onDone={schoolPrompt.dismiss}
      />

      {/* Referral / ambassador code modal – shown once after school prompt */}
      <ReferralCodeModal
        visible={showReferralModal}
        userId={user?.id ?? ''}
        onDone={referralPrompt.dismiss}
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
});

