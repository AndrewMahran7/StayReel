// components/RemoveAdsSheet.tsx
// Bottom sheet offering "Remove ads for 7 days" via rewarded ad.

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRewardedAd } from '@/hooks/useRewardedAd';
import C from '@/lib/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function RemoveAdsSheet({ visible, onClose }: Props) {
  const { loaded, loading, show } = useRewardedAd();

  const handleWatch = () => {
    const played = show();
    if (played) onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <Ionicons name="gift-outline" size={40} color={C.accent} style={styles.icon} />

          <Text style={styles.title}>Remove Ads for 7 Days</Text>
          <Text style={styles.body}>
            Watch a short video ad to enjoy StayReel ad-free for 7 days — completely free.
          </Text>

          {loading ? (
            <ActivityIndicator color={C.accent} style={{ marginVertical: 12 }} />
          ) : (
            <TouchableOpacity
              style={[styles.btn, !loaded && styles.btnDisabled]}
              onPress={handleWatch}
              disabled={!loaded}
            >
              <Ionicons name="play-circle" size={20} color="#fff" />
              <Text style={styles.btnText}>Watch a video ad</Text>
            </TouchableOpacity>
          )}

          {!loaded && !loading && (
            <Text style={styles.hint}>Ad not available right now. Try again later.</Text>
          )}

          <TouchableOpacity onPress={onClose} style={styles.skip}>
            <Text style={styles.skipText}>Maybe later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent:  'flex-end',
  },
  sheet: {
    backgroundColor:     C.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding:             28,
    alignItems:          'center',
    gap:                 12,
  },
  handle: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: C.border,
    marginBottom:    8,
  },
  icon: { marginBottom: 4 },
  title: {
    color:      C.textPrimary,
    fontSize:   20,
    fontWeight: '700',
    textAlign:  'center',
  },
  body: {
    color:      C.textSecondary,
    fontSize:   14,
    textAlign:  'center',
    lineHeight: 21,
    maxWidth:   300,
  },
  btn: {
    flexDirection:   'row',
    backgroundColor: C.accent,
    borderRadius:    14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems:      'center',
    gap:             8,
    alignSelf:       'stretch',
    justifyContent:  'center',
    marginTop:       4,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
  hint: {
    color:      C.textMuted,
    fontSize:   12,
    textAlign:  'center',
  },
  skip: { marginTop: 4 },
  skipText: {
    color:      C.textMuted,
    fontSize:   14,
  },
});
