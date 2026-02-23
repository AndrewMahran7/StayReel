// app/(tabs)/dashboard.tsx
// Dashboard: daily snapshot button with countdown, stats, growth chart.

import React, { useCallback, useEffect, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useDashboard }                                          from '@/hooks/useDashboard';
import { useSnapshotCapture, SnapshotLimitError, JobProgress } from '@/hooks/useSnapshotCapture';
import { DashboardCard }                       from '@/components/DashboardCard';
import { BannerAdView }                        from '@/components/BannerAdView';
import { StatsRow }                            from '@/components/StatsRow';
import { WeeklySummaryCard }                   from '@/components/WeeklySummaryCard';
import { StreakBadge }                         from '@/components/StreakBadge';
import { GrowthChart }                         from '@/components/GrowthChart';
import { useAuthStore }                        from '@/store/authStore';
import C                                       from '@/lib/colors';
import type { ListType }                       from '@/hooks/useListData';

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
  const { data, isLoading, refetch, isRefetching, error } = useDashboard();
  const capture                                = useSnapshotCapture();
  const [capturing, setCapturing]              = useState(false);
  const setPendingListType                     = useAuthStore((s) => s.setPendingListType);

  // next_allowed_at: prefer live API value, updated on rate-limit error
  const [overrideNextAt, setOverrideNextAt]    = useState<string | null>(null);
  const nextAllowedAt  = overrideNextAt ?? data?.next_snapshot_allowed_at ?? null;
  const countdown      = useCountdown(nextAllowedAt);
  const isLimited      = countdown !== null;

  // Clear override once the server confirms it's gone
  useEffect(() => {
    if (data?.next_snapshot_allowed_at === null) setOverrideNextAt(null);
  }, [data?.next_snapshot_allowed_at]);

  const handleRefresh  = useCallback(() => { refetch(); }, [refetch]);

  const handleCapture = async () => {
    if (isLimited) return;
    setCapturing(true);
    try {
      await capture.mutateAsync();
      setOverrideNextAt(null);
    } catch (err: any) {
      if (err instanceof SnapshotLimitError) {
        setOverrideNextAt(err.nextAllowedAt);
      } else {
        Alert.alert('Snapshot failed', err.message ?? 'Try again later.');
      }
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
            refreshing={isRefetching}
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
                <Text style={styles.captureBtnText}>{progressLabel(capture.progress)}</Text>
              </>
            ) : isLimited ? (
              <>
                <Ionicons name="time-outline" size={16} color="#fff" />
                <Text style={styles.captureBtnText}>{countdown}</Text>
              </>
            ) : (
              <>
                <Ionicons name="camera-outline" size={16} color="#fff" />
                <Text style={styles.captureBtnText}>Daily Snapshot</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Safety info text */}
        <Text style={styles.infoText}>
          One snapshot per day keeps your account safe.
        </Text>

        {/* ── Snapshot progress banner ─────────────────────────────── */}
        {(capturing || capture.isPending) && (
          <View style={styles.progressBanner}>
            <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.progressTitle}>
                {capture.progress.phase === 'followers'
                  ? `Fetching followers — ${capture.progress.followersSeen} so far`
                  : capture.progress.phase === 'following'
                  ? `Fetching following — ${capture.progress.followingSeen} so far`
                  : capture.progress.phase === 'finalize'
                  ? 'Saving snapshot…'
                  : 'Starting snapshot…'}
              </Text>
              {capture.progress.pagesDone > 0 && (
                <Text style={styles.progressSub}>
                  {capture.progress.pagesDone} page{capture.progress.pagesDone !== 1 ? 's' : ''} fetched
                </Text>
              )}
            </View>
          </View>
        )}

        {/* â”€â”€ Error â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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

        {/* â”€â”€ Net follower change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data?.net_follower_change != null && (
          <View style={[
            styles.netCard,
            data.net_follower_change >= 0 ? styles.netPositive : styles.netNegative,
          ]}>
            <Text style={styles.netLabel}>Net follower change</Text>
            <Text style={styles.netValue}>
              {data.net_follower_change >= 0 ? '+' : ''}
              {data.net_follower_change.toLocaleString()}
            </Text>
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

        {/* â”€â”€ First-snapshot hint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {data && !data.has_diff && (
          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={C.textMuted} />
            <Text style={styles.hintText}>
              Come back tomorrow for your first Daily Snapshot comparison.
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
              <Text style={styles.emptyBold}>Daily Snapshot</Text>
              {' '}to capture your first snapshot and start tracking your growth.
            </Text>
          </View>
        )}
      </ScrollView>
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

  progressBanner: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.surface,
    borderRadius:    10,
    padding:         12,
    marginBottom:    12,
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
  },
  progressTitle: {
    color:      C.textPrimary,
    fontSize:   13,
    fontWeight: '600',
  },
  progressSub: {
    color:      C.textMuted,
    fontSize:   11,
    marginTop:  2,
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
});

