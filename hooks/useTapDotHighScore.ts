// hooks/useTapDotHighScore.ts
// Persists the "Tap the Dot" high-score with AsyncStorage.

import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'stayreel.tapdot.highscore';

export function useTapDotHighScore() {
  const [highScore, setHighScore] = useState<number>(0);
  const [loaded,    setLoaded]    = useState(false);

  // Load once on mount.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((val) => { if (val !== null) setHighScore(parseInt(val, 10) || 0); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Call this at the end of each run; it only writes if the new score is higher.
  const maybeUpdate = useCallback((score: number) => {
    setHighScore((prev) => {
      if (score > prev) {
        AsyncStorage.setItem(STORAGE_KEY, String(score)).catch(() => {});
        return score;
      }
      return prev;
    });
  }, []);

  return { highScore, loaded, maybeUpdate };
}
