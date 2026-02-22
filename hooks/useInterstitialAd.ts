// hooks/useInterstitialAd.ts
// Ads removed — returns a no-op until a native build is set up.

export function useInterstitialAd() {
  return { showIfReady: (): boolean => false };
}
