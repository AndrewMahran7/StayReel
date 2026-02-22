// components/CookieHelpModal.tsx
// Step-by-step guide for extracting the Instagram session cookie.

import React from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

const STEPS = [
  {
    num: '1',
    title: 'Open Instagram in a desktop browser',
    body: 'Log in to instagram.com from Chrome, Firefox, or Safari on your computer.',
  },
  {
    num: '2',
    title: 'Open DevTools',
    body: 'Press F12 (Windows/Linux) or ⌘ Opt I (Mac) to open browser developer tools.',
  },
  {
    num: '3',
    title: 'Go to Application → Cookies',
    body: 'Select the "Application" tab, then expand "Cookies" and click "https://www.instagram.com".',
  },
  {
    num: '4',
    title: 'Find the sessionid cookie',
    body: 'Scroll down to find the row named "sessionid". Copy its entire Value (a long alphanumeric string).',
  },
  {
    num: '5',
    title: 'Paste into StayReel',
    body: 'Paste the copied value into the Session Cookie field in the app. It will be encrypted and stored securely — we never see your password.',
  },
];

interface Props {
  visible:  boolean;
  onClose:  () => void;
}

export function CookieHelpModal({ visible, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>How to get your session cookie</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color={C.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Warning banner */}
          <View style={styles.warning}>
            <Ionicons name="shield-checkmark" size={18} color={C.amber} />
            <Text style={styles.warningText}>
              Your cookie is encrypted with AES-256 and only used for follower
              fetches. Never share it anywhere else.
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {STEPS.map((step) => (
              <View key={step.num} style={styles.step}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{step.num}</Text>
                </View>
                <View style={styles.stepBody}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepDesc}>{step.body}</Text>
                </View>
              </View>
            ))}

            {/* Extra safety note */}
            <View style={styles.noteBox}>
              <Ionicons name="information-circle" size={16} color={C.teal} />
              <Text style={styles.noteText}>
                If you log out of Instagram on your browser the cookie expires and
                you&apos;ll need to reconnect. Rotate it regularly for safety.
              </Text>
            </View>
          </ScrollView>

          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Got it</Text>
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
    backgroundColor:    C.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding:            20,
    maxHeight:          '85%',
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   12,
  },
  title: {
    color:      C.textPrimary,
    fontSize:   17,
    fontWeight: '700',
  },
  warning: {
    flexDirection:    'row',
    backgroundColor:  C.amberDim,
    borderRadius:     10,
    padding:          12,
    gap:              10,
    marginBottom:     16,
    alignItems:       'flex-start',
  },
  warningText: {
    flex:       1,
    color:      C.amber,
    fontSize:   13,
    lineHeight: 19,
  },
  step: {
    flexDirection: 'row',
    gap:           12,
    marginBottom:  18,
  },
  stepNum: {
    width:           26,
    height:          26,
    borderRadius:    13,
    backgroundColor: C.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
    marginTop:       2,
  },
  stepNumText: {
    color:      C.accent,
    fontSize:   13,
    fontWeight: '700',
  },
  stepBody: {
    flex: 1,
  },
  stepTitle: {
    color:      C.textPrimary,
    fontSize:   14,
    fontWeight: '600',
    marginBottom: 3,
  },
  stepDesc: {
    color:      C.textSecondary,
    fontSize:   13,
    lineHeight: 20,
  },
  noteBox: {
    flexDirection:   'row',
    backgroundColor: C.tealDim,
    borderRadius:    10,
    padding:         12,
    gap:             8,
    marginBottom:    16,
    alignItems:      'flex-start',
  },
  noteText: {
    flex:       1,
    color:      C.teal,
    fontSize:   12,
    lineHeight: 18,
  },
  closeBtn: {
    backgroundColor: C.accent,
    borderRadius:    14,
    height:          50,
    alignItems:      'center',
    justifyContent:  'center',
    marginTop:       8,
  },
  closeBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
});
