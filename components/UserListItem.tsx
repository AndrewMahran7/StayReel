// components/UserListItem.tsx

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet,
  Linking, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';
import type { IgUser } from '@/hooks/useListData';

// Consistent colour per username so fallback avatars are colourful
const AVATAR_COLORS = ['#E91E63','#9C27B0','#3F51B5','#0288D1','#00897B','#F4511E','#F6BF26'];
function avatarColor(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

interface Props {
  user:        IgUser;
  index:       number;
  /** When provided, an Unfollow button is shown for this row. */
  onUnfollow?:  (igId: string) => void;
  /** Whether this specific user's unfollow is currently in-flight. */
  unfollowPending?: boolean;
  /** Whether this user has already been unfollowed this session. */
  unfollowDone?:    boolean;
}

export function UserListItem({ user, onUnfollow, unfollowPending, unfollowDone }: Props) {
  const [imgError, setImgError] = useState(false);

  const openProfile = () => {
    Linking.openURL(`https://www.instagram.com/${user.username}/`);
  };

  return (
    <TouchableOpacity style={styles.row} onPress={openProfile} activeOpacity={0.7}>
      {/* Avatar: real profile pic via unavatar proxy, fallback to coloured initial */}
      <View style={[styles.avatar, imgError && { backgroundColor: avatarColor(user.username) }]}>
        {!imgError ? (
          <Image
            source={{ uri: `https://unavatar.io/instagram/${user.username}` }}
            style={styles.avatarImg}
            onError={() => setImgError(true)}
          />
        ) : (
          <Text style={styles.avatarText}>
            {(user.username[0] ?? '?').toUpperCase()}
          </Text>
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.username} numberOfLines={1}>
          @{user.username}
        </Text>
      </View>

      {onUnfollow ? (
        <TouchableOpacity
          style={[
            styles.unfollowBtn,
            unfollowDone && styles.unfollowBtnDone,
          ]}
          onPress={() => !unfollowDone && onUnfollow(user.ig_id)}
          disabled={unfollowPending || unfollowDone}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {unfollowPending ? (
            <ActivityIndicator size="small" color={C.accent} />
          ) : unfollowDone ? (
            <Text style={styles.unfollowBtnDoneText}>Unfollowed</Text>
          ) : (
            <Text style={styles.unfollowBtnText}>Unfollow</Text>
          )}
        </TouchableOpacity>
      ) : (
        <Ionicons name="open-outline" size={15} color={C.textMuted} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection:    'row',
    alignItems:       'center',
    paddingVertical:  12,
    paddingHorizontal: 16,
    gap:              12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  avatar: {
    width:           42,
    height:          42,
    borderRadius:    21,
    backgroundColor: C.surfaceAlt,
    alignItems:      'center',
    justifyContent:  'center',
    overflow:        'hidden',
  },
  avatarImg: {
    width:        42,
    height:       42,
    borderRadius: 21,
  },
  avatarText: {
    color:      '#fff',
    fontSize:   17,
    fontWeight: '700',
  },
  info: {
    flex: 1,
  },
  username: {
    color:    C.textPrimary,
    fontSize: 15,
  },
  unfollowBtn: {
    paddingVertical:   5,
    paddingHorizontal: 12,
    borderRadius:      14,
    borderWidth:       1,
    borderColor:       C.accent,
    minWidth:          80,
    alignItems:        'center',
    justifyContent:    'center',
  },
  unfollowBtnDone: {
    borderColor: C.border,
  },
  unfollowBtnText: {
    color:      C.accent,
    fontSize:   13,
    fontWeight: '600',
  },
  unfollowBtnDoneText: {
    color:      C.textMuted,
    fontSize:   13,
    fontWeight: '500',
  },
});
