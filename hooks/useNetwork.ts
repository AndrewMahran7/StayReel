// hooks/useNetwork.ts
// Thin wrapper around @react-native-community/netinfo that exposes a
// simple boolean `isOffline` for the rest of the app.

import { useEffect, useState } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

/**
 * Returns `true` when the device has no internet connectivity.
 *
 * Internally subscribes to NetInfo and updates reactively.
 * On first render, defaults to `false` (assume online) to avoid
 * a flash of "offline" before the real check completes.
 */
export function useNetwork() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      // isInternetReachable can be null while the check is in progress.
      // Treat null as "online" to avoid false positives.
      const offline =
        state.isConnected === false ||
        state.isInternetReachable === false;
      setIsOffline(offline);
    });
    return () => unsubscribe();
  }, []);

  return { isOffline };
}
