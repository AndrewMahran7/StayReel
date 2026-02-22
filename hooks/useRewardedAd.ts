// hooks/useRewardedAd.ts
import { useEffect, useRef, useState } from 'react';
import { RewardedAd, RewardedAdEventType, AdEventType } from 'react-native-google-mobile-ads';
import { useAdStore } from '@/store/adStore';
import { AD_UNITS } from '@/lib/adUnits';

export function useRewardedAd() {
  const removeAdsForDays = useAdStore(s => s.removeAdsForDays);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const adRef = useRef<RewardedAd | null>(null);

  function createAd() {
    const ad = RewardedAd.createForAdRequest(AD_UNITS.rewarded, {
      requestNonPersonalizedAdsOnly: false,
    });
    adRef.current = ad;
    setLoaded(false);
    setLoading(true);

    const unsubLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
      setLoaded(true);
      setLoading(false);
    });
    const unsubEarned = ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
      removeAdsForDays(7);
    });
    const unsubFailed = ad.addAdEventListener(AdEventType.ERROR, () => {
      setLoaded(false);
      setLoading(false);
    });
    const unsubClosed = ad.addAdEventListener(AdEventType.CLOSED, () => {
      unsubLoaded();
      unsubEarned();
      unsubFailed();
      unsubClosed();
      // Pre-load next ad
      createAd();
    });

    ad.load();
  }

  useEffect(() => {
    createAd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function show(): boolean {
    if (!loaded || !adRef.current) return false;
    adRef.current.show();
    return true;
  }

  return { loaded, loading, show, reload: createAd };
}
