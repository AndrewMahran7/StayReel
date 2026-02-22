-- ============================================================
-- seed.sql — Development / CI seed data
-- Run AFTER all migrations. Uses service-role key only.
-- DO NOT run in production.
-- ============================================================

-- ── Seed a test user ─────────────────────────────────────────
-- Supabase Auth user must exist first; create via Auth Admin API
-- or Supabase dashboard, then paste the UUID below.
--
-- Example (replace uuid with real auth.users.id):

DO $$
DECLARE
  v_user_id  UUID := '00000000-0000-0000-0000-000000000001';
  v_ig_id    UUID;
  v_snap1    UUID;
  v_snap2    UUID;
BEGIN

  -- Profile (normally created by handle_new_user trigger)
  INSERT INTO public.profiles (id, display_name)
  VALUES (v_user_id, 'Test User')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (v_user_id)
  ON CONFLICT DO NOTHING;

  -- Connected IG account (vault_secret_id NULL in dev)
  INSERT INTO public.ig_accounts (
    id, user_id, ig_user_id, username, status,
    token_type, token_expires_at, last_verified_at
  )
  VALUES (
    gen_random_uuid(), v_user_id, '123456789', 'testuser_ig',
    'active', 'basic_display',
    NOW() + INTERVAL '55 days', NOW()
  )
  RETURNING id INTO v_ig_id;

  -- Two consecutive snapshots
  INSERT INTO public.follower_snapshots (
    id, ig_account_id, captured_at, source,
    follower_count, following_count, post_count,
    followers_json, is_list_complete
  )
  VALUES (
    gen_random_uuid(), v_ig_id, NOW() - INTERVAL '1 day', 'cron',
    1000, 500, 42,
    '[
      {"ig_id":"111","username":"alice"},
      {"ig_id":"222","username":"bob"},
      {"ig_id":"333","username":"charlie"}
    ]'::JSONB,
    TRUE
  )
  RETURNING id INTO v_snap1;

  INSERT INTO public.follower_snapshots (
    id, ig_account_id, captured_at, source,
    follower_count, following_count, post_count,
    followers_json, is_list_complete
  )
  VALUES (
    gen_random_uuid(), v_ig_id, NOW(), 'manual',
    1001, 500, 42,
    '[
      {"ig_id":"111","username":"alice"},
      {"ig_id":"333","username":"charlie"},
      {"ig_id":"444","username":"dave"}
    ]'::JSONB,
    TRUE
  )
  RETURNING id INTO v_snap2;

  -- Corresponding diff (bob unfollowed; dave is new)
  INSERT INTO public.diffs (
    ig_account_id,
    from_snapshot_id, to_snapshot_id,
    from_captured_at, to_captured_at,
    net_follower_change,
    new_followers, lost_followers,
    not_following_back, you_dont_follow_back,
    is_complete
  )
  VALUES (
    v_ig_id, v_snap1, v_snap2,
    NOW() - INTERVAL '1 day', NOW(),
    1,
    '[{"ig_id":"444","username":"dave"}]'::JSONB,
    '[{"ig_id":"222","username":"bob"}]'::JSONB,
    '[]'::JSONB,
    '[]'::JSONB,
    TRUE
  );

  -- Seed follower_edges for latest snapshot
  INSERT INTO public.follower_edges (ig_account_id, snapshot_id, captured_at, follower_ig_id, follower_username)
  VALUES
    (v_ig_id, v_snap2, NOW(), '111', 'alice'),
    (v_ig_id, v_snap2, NOW(), '333', 'charlie'),
    (v_ig_id, v_snap2, NOW(), '444', 'dave');

  -- Audit event
  INSERT INTO public.audit_events (user_id, ig_account_id, event_type, payload, source)
  VALUES (
    v_user_id, v_ig_id, 'snapshot_taken',
    jsonb_build_object(
      'snapshot_id', v_snap2,
      'follower_count', 1001,
      'source', 'manual'
    ),
    'seed'
  );

END $$;
