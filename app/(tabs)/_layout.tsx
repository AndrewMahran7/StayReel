// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ReferralCodeModal } from '@/components/ReferralCodeModal';
import { useReferralPrompt } from '@/hooks/useReferralPrompt';
import { useSchoolPrompt } from '@/hooks/useSchoolPrompt';
import { useAuthStore } from '@/store/authStore';
import C from '@/lib/colors';

export default function TabsLayout() {
  const user = useAuthStore((s) => s.user);
  const schoolPrompt = useSchoolPrompt();
  const referralPrompt = useReferralPrompt();

  // Only show referral modal when school prompt is NOT showing (avoids stacking)
  const showReferralModal =
    referralPrompt.shouldShow && !schoolPrompt.shouldShow;

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown:      false,
          tabBarStyle: {
            backgroundColor: C.tabBar,
            borderTopColor:  C.border,
            borderTopWidth:  1,
          },
          tabBarActiveTintColor:   C.accent,
          tabBarInactiveTintColor: C.textMuted,
          tabBarLabelStyle: {
            fontSize:   11,
            fontWeight: '600',
            marginBottom: 2,
          },
        }}
      >
        <Tabs.Screen
          name="dashboard"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <Ionicons name="grid-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="lists"
          options={{
            title: 'Lists',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <Ionicons name="people-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color, size }: { color: string; size: number }) => (
              <Ionicons name="settings-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>

      {/* Single mount point for the auto-show referral prompt.
          Renders above all tabs to avoid duplicate modal mounts. */}
      <ReferralCodeModal
        visible={showReferralModal}
        userId={user?.id ?? ''}
        onDone={referralPrompt.dismiss}
      />
    </>
  );
}
