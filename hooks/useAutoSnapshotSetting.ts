// hooks/useAutoSnapshotSetting.ts
// Read + write auto_snapshot_enabled from ig_accounts table.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

interface AutoSnapshotSetting {
  enabled:   boolean;
  isLoading: boolean;
  toggle:    () => Promise<void>;
}

export function useAutoSnapshotSetting(): AutoSnapshotSetting {
  const igAccountId = useAuthStore((s) => s.igAccountId);
  const [enabled, setEnabled]     = useState(true); // default ON
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!igAccountId) return;
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('ig_accounts')
        .select('auto_snapshot_enabled')
        .eq('id', igAccountId)
        .maybeSingle();

      if (!cancelled) {
        setEnabled(data?.auto_snapshot_enabled ?? true);
        setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [igAccountId]);

  const toggle = useCallback(async () => {
    if (!igAccountId) return;
    const newValue = !enabled;
    setEnabled(newValue); // optimistic
    const { error } = await supabase
      .from('ig_accounts')
      .update({
        auto_snapshot_enabled: newValue,
        updated_at: new Date().toISOString(),
      })
      .eq('id', igAccountId);

    if (error) {
      setEnabled(!newValue); // revert
      throw error;
    }
  }, [igAccountId, enabled]);

  return { enabled, isLoading, toggle };
}
