// app/(tabs)/lists.tsx
// Searchable, paginated user list.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useListData, type ListType, type IgUser } from '@/hooks/useListData';
import { useReviewPrompt }      from '@/hooks/useReviewPrompt';
import { useAuthStore }         from '@/store/authStore';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { useUnfollowUser }      from '@/hooks/useUnfollowUser';
import { SearchBar }            from '@/components/SearchBar';
import { UserListItem }         from '@/components/UserListItem';
import { BannerAdView }         from '@/components/BannerAdView';
import { LockedUserRow }        from '@/components/LockedUserRow';
import { PaywallModal }         from '@/components/PaywallModal';
import { trackEvent }           from '@/lib/analytics';
import C from '@/lib/colors';

/** Contextual upsell copy per list type — short, emotionally relevant. */
const UPSELL_COPY: Record<ListType, { headline: string; subtitle: string }> = {
  new_followers:        { headline: 'See all your new followers',        subtitle: 'Know exactly who started following you.'           },
  lost_followers:       { headline: 'See everyone who unfollowed you',   subtitle: 'Find out who left — no more guessing.'             },
  not_following_back:   { headline: "See who doesn't follow you back",   subtitle: 'Stop giving follows that are never returned.'       },
  you_dont_follow_back: { headline: 'See all your secret fans',          subtitle: 'Discover followers you haven\u2019t followed back.' },
  you_unfollowed:       { headline: 'See your full unfollow history',    subtitle: 'Track every account you\u2019ve removed.'            },
};

const TABS: { key: ListType; label: string }[] = [
  { key: 'new_followers',        label: 'New'       },
  { key: 'lost_followers',       label: 'Lost'      },
  { key: 'not_following_back',   label: 'Ghost'     },
  { key: 'you_dont_follow_back', label: "Don't follow" },
  { key: 'you_unfollowed',       label: 'Unfollowed'},
];

export default function ListsScreen() {
  const params = useLocalSearchParams<{ type?: ListType }>();
  const pendingListType  = useAuthStore((s) => s.pendingListType);
  const setPendingListType = useAuthStore((s) => s.setPendingListType);

  const [activeType, setActiveType] = useState<ListType>(
    (pendingListType as ListType) ?? params.type ?? 'new_followers',
  );
  const [search, setSearch] = useState('');

  // Consume pendingListType set by Dashboard card tap.
  // Using a store value is reliable even when the tab is already mounted.
  useEffect(() => {
    if (pendingListType) {
      setActiveType(pendingListType as ListType);
      setSearch('');
      setPendingListType(null); // consume so it doesn't re-fire
    }
  }, [pendingListType]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
  } = useListData(activeType, search);

  const igAccountId = useAuthStore((s) => s.igAccountId);
  const isPro        = useSubscriptionStore((s) => s.isPro);
  const { unfollow, unfollowed, pendingId } = useUnfollowUser();
  const [paywallOpen, setPaywallOpen] = useState(false);

  // In-app review prompt — fires once when a high-value list loads with results
  const { maybePromptReview } = useReviewPrompt();
  const reviewFiredRef = useRef<string | null>(null);

  const handleTabPress = useCallback((type: ListType) => {
    if (type === activeType) return;
    setActiveType(type);
    setSearch('');
    trackEvent('list_opened', { list_type: type });
  }, [activeType]);

  const items: IgUser[] = data?.pages.flatMap((p: { items: IgUser[] }) => p.items) ?? [];

  // Trigger review prompt after items are resolved
  useEffect(() => {
    if (!isLoading && items.length > 0 && reviewFiredRef.current !== activeType) {
      reviewFiredRef.current = activeType;
      maybePromptReview(activeType, items.length);
    }
  }, [isLoading, items.length, activeType, maybePromptReview]);

  // Freemium gating: check if the server truncated the list
  const firstPage  = data?.pages[0];
  const totalCount = firstPage?.total ?? items.length;
  const serverLimited  = firstPage?.isLimited ?? false;

  // ── Client-side safety net ────────────────────────────────────
  // If the server says "not limited" but the local subscription store
  // knows the user is free, enforce the limit client-side.  This
  // handles stale DB subscription_status or un-deployed Edge Functions.
  const FREE_PREVIEW_LIMIT = 10;
  const clientOverride = !isPro && !serverLimited && totalCount > FREE_PREVIEW_LIMIT;
  const isLimited      = serverLimited || clientOverride;

  // When the client overrides, only show the first N items
  const visibleItems = clientOverride ? items.slice(0, FREE_PREVIEW_LIMIT) : items;

  // ── DEBUG: gating state ───────────────────────────────────────
  if (__DEV__ && firstPage) {
    console.log('[Lists] gating:', {
      isPro,
      serverLimited,
      clientOverride,
      isLimited,
      totalCount,
      itemsReceived: items.length,
      itemsVisible:  visibleItems.length,
    });
  }

  /** Number of locked teaser rows to display (visual hint, not real data). */
  const LOCKED_TEASER_COUNT = 5;
  const hiddenCount = isLimited ? totalCount - visibleItems.length : 0;

  // Track locked rows impression (once per list type per mount)
  const lockedSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (isLimited && hiddenCount > 0 && !lockedSeenRef.current.has(activeType)) {
      lockedSeenRef.current.add(activeType);
      trackEvent('locked_rows_seen', {
        list_type:    activeType,
        visible:      items.length,
        hidden:       hiddenCount,
        total:        totalCount,
      });
    }
  }, [isLimited, hiddenCount, activeType, items.length, totalCount]);

  const renderFooter = () => {
    if (isLimited && hiddenCount > 0) {
      return (
        <View>
          {/* Locked teaser rows — fading opacity to imply more content */}
          {Array.from({ length: Math.min(LOCKED_TEASER_COUNT, hiddenCount) }).map((_, i) => (
            <LockedUserRow key={`locked-${i}`} opacity={1 - i * 0.18} />
          ))}

          {/* Inline upgrade card — contextual copy per list type */}
          <View style={styles.unlockCard}>
            <View style={styles.unlockIconRow}>
              <View style={styles.unlockIconCircle}>
                <Ionicons name="lock-open" size={18} color={C.accent} />
              </View>
            </View>

            <Text style={styles.unlockHeadline}>
              {UPSELL_COPY[activeType].headline}
            </Text>
            <Text style={styles.unlockSubtext}>
              {UPSELL_COPY[activeType].subtitle}
            </Text>

            <TouchableOpacity
              style={styles.unlockBtn}
              onPress={() => {
                trackEvent('upgrade_cta_clicked', {
                  list_type: activeType,
                  hidden:    hiddenCount,
                  total:     totalCount,
                });
                setPaywallOpen(true);
              }}
              activeOpacity={0.8}
            >
              <Ionicons name="star" size={15} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.unlockBtnText}>
                Unlock all {totalCount.toLocaleString()} accounts
              </Text>
            </TouchableOpacity>

            <Text style={styles.unlockFinePrint}>StayReel Pro</Text>
          </View>
        </View>
      );
    }
    if (!isFetchingNextPage) return null;
    return <ActivityIndicator color={C.accent} style={{ paddingVertical: 16 }} />;
  };

  return (
    <SafeAreaView style={styles.safe}>
      <BannerAdView />

      {/* Screen title */}
      <View style={styles.titleRow}>
        <Text style={styles.screenTitle}>Lists</Text>
        {isLoading && <ActivityIndicator size="small" color={C.accent} />}
      </View>

      {/* Type tabs — horizontal scroll */}
      <View>
        <FlatList
          horizontal
          data={TABS}
          keyExtractor={(t) => t.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabList}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.tab, activeType === item.key && styles.tabActive]}
              onPress={() => handleTabPress(item.key)}
            >
              <Text style={[styles.tabText, activeType === item.key && styles.tabTextActive]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {/* Search */}
      <SearchBar value={search} onChangeText={setSearch} />

      {/* Error */}
      {error && (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle" size={16} color={C.red} />
          <Text style={styles.errorText}>{error.message}</Text>
        </View>
      )}

      {/* User list */}
      <FlatList
        data={visibleItems}
        keyExtractor={(u, i) => u.ig_id || u.username + i}
        renderItem={({ item, index }) => (
          <UserListItem
            user={item}
            index={index}
            onUnfollow={
              activeType === 'not_following_back' && igAccountId
                ? (igId) => unfollow(igAccountId, igId)
                : undefined
            }
            unfollowPending={pendingId === item.ig_id}
            unfollowDone={unfollowed.has(item.ig_id)}
          />
        )}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={C.textMuted} />
              <Text style={styles.emptyText}>
                {search.trim()
                  ? 'No matching users'
                  : ['new_followers','lost_followers','you_unfollowed'].includes(activeType)
                    ? 'Take a second snapshot to see changes'
                    : 'Nothing here yet'}
              </Text>
            </View>
          ) : null
        }
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage && !isLimited) fetchNextPage();
        }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
      {/* Paywall modal */}
      <PaywallModal visible={paywallOpen} onClose={() => setPaywallOpen(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.black },
  titleRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            10,
    paddingHorizontal: 16,
    paddingTop:     12,
    paddingBottom:  4,
  },
  screenTitle: {
    color:      C.textPrimary,
    fontSize:   26,
    fontWeight: '800',
    letterSpacing: -0.5,
    flex: 1,
  },
  tabList: {
    paddingHorizontal: 12,
    paddingVertical:   8,
    gap:               6,
  },
  tab: {
    paddingVertical:   7,
    paddingHorizontal: 14,
    borderRadius:      20,
    backgroundColor:   C.surfaceAlt,
    borderWidth:       1,
    borderColor:       C.border,
  },
  tabActive: {
    backgroundColor: C.accentDim,
    borderColor:     C.accent,
  },
  tabText: {
    color:    C.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  tabTextActive: {
    color:      C.accent,
    fontWeight: '700',
  },
  errorBox: {
    flexDirection:    'row',
    backgroundColor:  C.redDim,
    borderRadius:     10,
    padding:          12,
    gap:              8,
    marginHorizontal: 16,
    marginBottom:     8,
  },
  errorText: { color: C.red, fontSize: 13, flex: 1 },
  empty: {
    alignItems:  'center',
    paddingTop:   60,
    gap:          12,
  },
  emptyText: {
    color:    C.textMuted,
    fontSize: 15,
  },
  // ── Unlock card (inline after locked rows) ────────────────
  unlockCard: {
    alignItems:       'center',
    marginHorizontal: 16,
    marginTop:        8,
    marginBottom:     24,
    paddingVertical:  28,
    paddingHorizontal: 24,
    borderRadius:     16,
    backgroundColor:  C.surface,
    borderWidth:      1,
    borderColor:      C.border,
  },
  unlockIconRow: {
    marginBottom: 12,
  },
  unlockIconCircle: {
    width:           40,
    height:          40,
    borderRadius:    20,
    backgroundColor: C.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
  },
  unlockHeadline: {
    color:       C.textPrimary,
    fontSize:    18,
    fontWeight:  '700',
    textAlign:   'center',
    letterSpacing: -0.3,
  },
  unlockSubtext: {
    color:      C.textSecondary,
    fontSize:   14,
    marginTop:  6,
    textAlign:  'center',
    lineHeight: 20,
  },
  unlockBtn: {
    flexDirection:    'row',
    alignItems:       'center',
    backgroundColor:  C.accent,
    borderRadius:     22,
    paddingVertical:  12,
    paddingHorizontal: 28,
    marginTop:        20,
    shadowColor:      C.accent,
    shadowOffset:     { width: 0, height: 4 },
    shadowOpacity:    0.4,
    shadowRadius:     8,
    elevation:        5,
  },
  unlockBtnText: {
    color:      '#fff',
    fontSize:   15,
    fontWeight: '700',
  },
  unlockFinePrint: {
    color:      C.textMuted,
    fontSize:   11,
    marginTop:  10,
    letterSpacing: 0.3,
  },
});
