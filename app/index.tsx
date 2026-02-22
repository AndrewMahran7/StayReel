import { Redirect } from 'expo-router';

// Root index — AuthGuard in _layout.tsx handles all real navigation.
// This just gives Expo Router a matched route for "/" so it doesn't
// show "Unmatched Route" before the guard fires.
export default function Index() {
  return <Redirect href="/(auth)/sign-in" />;
}
