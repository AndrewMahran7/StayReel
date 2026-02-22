// app/(tabs)/lists.tsx
// Searchable, paginated user list.
// Interstitial shown every 3rd list-type toggle.

import React, { useCallback, useEffect, useState } from 'react';
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
import { useInterstitialAd } from '@/hooks/useInterstitialAd';
import { useAdStore, INTERSTITIAL_EVERY_N_OPENS } from '@/store/adStore';
import { useAuthStore } from '@/store/authStore';
import { SearchBar } from '@/components/SearchBar';
import { UserListItem } from '@/components/UserListItem';
import { BannerAdView } from '@/components/BannerAdView';
import C from '@/lib/colors';

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

  const { showIfReady }          = useInterstitialAd();
  const { incrementListOpens }   = useAdStore();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
  } = useListData(activeType, search);

  // Switch list type with interstitial frequency cap
  const handleTabPress = useCallback(async (type: ListType) => {
    if (type === activeType) return;
    setActiveType(type);
    setSearch('');

    const count = await incrementListOpens();
    if (count % INTERSTITIAL_EVERY_N_OPENS === 0) {
      showIfReady();
    }
  }, [activeType, incrementListOpens, showIfReady]);

  const items: IgUser[] = data?.pages.flatMap((p: { items: IgUser[] }) => p.items) ?? [];

  const renderFooter = () => {
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
        data={items}
        keyExtractor={(u, i) => u.ig_id || u.username + i}
        renderItem={({ item, index }) => (
          <UserListItem user={item} index={index} />
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
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
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
});
