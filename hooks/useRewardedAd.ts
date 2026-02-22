// hooks/useRewardedAd.ts
// Ads removed — returns a no-op until a native build is set up.

export function useRewardedAd() {
  return {
    loaded: false,
    loading: false,
    show: (): boolean => false,
    reload: () => {},
  };
}
