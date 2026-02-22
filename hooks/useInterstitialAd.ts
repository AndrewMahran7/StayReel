// hooks/useInterstitialAd.ts
// Interstitial ads disabled by design.
export function useInterstitialAd() {
  return { showIfReady: (): boolean => false };
}
