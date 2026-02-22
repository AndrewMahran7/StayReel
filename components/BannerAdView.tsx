// components/BannerAdView.tsx
// Set BANNER_ADS_ENABLED = true to re-enable banner ads.
const BANNER_ADS_ENABLED = false;

import React from 'react';
import { View } from 'react-native';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { useAdStore, selectAdsActive } from '@/store/adStore';
import { AD_UNITS } from '@/lib/adUnits';

interface Props {
  style?: object;
}

export function BannerAdView({ style }: Props) {
  const adsActive = useAdStore(selectAdsActive);
  if (!BANNER_ADS_ENABLED || !adsActive) return null;

  return (
    <View style={style}>
      <BannerAd
        unitId={AD_UNITS.banner}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: false }}
      />
    </View>
  );
}
