# Ambassador Payout Queries

> **Last updated:** 2026-03-24
>
> This document contains all SQL queries needed to calculate ambassador performance,
> estimated revenue, school breakdowns, and leaderboards for StayReel.
>
> **Target database:** Supabase (PostgreSQL 15+)

---

## Assumptions

| Assumption | Detail |
|---|---|
| **Profile table** | `profiles` contains `id`, `school`, `subscription_status`, `subscription_expires_at`, `referred_by`, `referred_at` |
| **Subscription status** | `subscription_status` is kept in sync by the RevenueCat webhook. Values: `'active'`, `'free'`, `'expired'`, `'cancelled'` (treat `'active'` as currently paying) |
| **Plan pricing** | No per-user price column exists yet. We estimate revenue using two manual placeholders: `:monthly_price` (e.g. 3.99) and `:annual_monthly_equivalent` (e.g. 2.49 = annual price / 12) |
| **Plan type** | We cannot yet distinguish monthly vs annual subscribers from `profiles` alone. The MVP queries assume all active subscribers pay `:monthly_price`. An optional "best-guess" variant uses `subscription_expires_at` heuristics to split monthly/annual |
| **Fiscal month** | Represented by `:month_start` (inclusive) and `:month_end` (exclusive), e.g. `'2026-03-01'` / `'2026-04-01'` |
| **Attribution window** | A referred user counts toward a month if they were referred (`referred_at`) **before** `:month_end` and are actively paying during that month (`subscription_status = 'active'` and `subscription_expires_at >= :month_start`) |
| **Ambassador code** | Stored in `profiles.referred_by`. Codes are lowercase alphanumeric + hyphens/underscores, 3-30 chars |
| **Payout basis (MVP)** | Use the estimated revenue queries (Section 2) for payouts until a `billing_events` table is added. See the note in Section 3 for the difference |

---

## 1. Placeholder Reference

| Placeholder | Type | Example |
|---|---|---|
| `:month_start` | `date` or `timestamptz` | `'2026-03-01'` |
| `:month_end` | `date` or `timestamptz` | `'2026-04-01'` |
| `:ambassador_code` | `text` | `'emma_dance'` |
| `:school_name` | `text` | `'Westlake High School'` |
| `:monthly_price` | `numeric` | `3.99` |
| `:annual_monthly_equivalent` | `numeric` | `2.49` |

---

## 2. MVP Estimated Revenue Queries

These queries estimate revenue from the current state of `profiles`. They do **not** use
transaction records and should be treated as approximations suitable for early-stage payouts.

### 2A. Ambassador Monthly Summary

```sql
-- Returns one row per ambassador for the given fiscal month:
--   ambassador code, total referred users, active paying users,
--   estimated monthly revenue.
-- "Referred users" = anyone with referred_by = that code whose referred_at < month_end.
-- "Active paying" = referred AND subscription_status = 'active'
--   AND subscription_expires_at >= month_start.

SELECT
    p.referred_by                                       AS ambassador_code,
    COUNT(*)                                            AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                                   AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price                                  AS estimated_revenue
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND p.referred_at < :month_end
GROUP BY p.referred_by
ORDER BY estimated_revenue DESC;
```

### 2A-alt. Ambassador Monthly Summary (Monthly vs Annual Split)

```sql
-- Best-guess split of monthly vs annual subscribers.
-- Heuristic: if subscription_expires_at is > 60 days from now, treat as annual.
-- This is approximate — replace with a real plan_type column when available.

SELECT
    p.referred_by                                       AS ambassador_code,
    COUNT(*)                                            AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                                   AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
          AND p.subscription_expires_at < NOW() + INTERVAL '60 days'
    )                                                   AS est_monthly_subscribers,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
          AND p.subscription_expires_at >= NOW() + INTERVAL '60 days'
    )                                                   AS est_annual_subscribers,
    (
        COUNT(*) FILTER (
            WHERE p.subscription_status = 'active'
              AND p.subscription_expires_at >= :month_start
              AND p.subscription_expires_at < NOW() + INTERVAL '60 days'
        ) * :monthly_price
      + COUNT(*) FILTER (
            WHERE p.subscription_status = 'active'
              AND p.subscription_expires_at >= :month_start
              AND p.subscription_expires_at >= NOW() + INTERVAL '60 days'
        ) * :annual_monthly_equivalent
    )                                                   AS estimated_revenue
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND p.referred_at < :month_end
GROUP BY p.referred_by
ORDER BY estimated_revenue DESC;
```

### 2B. Ambassador + School Summary

```sql
-- Returns one row per (ambassador, school) pair for the fiscal month.
-- Useful for understanding which schools each ambassador is driving.

SELECT
    p.referred_by                                       AS ambassador_code,
    COALESCE(p.school, '(no school)')                   AS school,
    COUNT(*)                                            AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                                   AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price                                  AS estimated_revenue
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND p.referred_at < :month_end
GROUP BY p.referred_by, p.school
ORDER BY p.referred_by, estimated_revenue DESC;
```

---

## 3. Exact Revenue Queries (Future — Requires `billing_events` Table)

### Important: Estimated vs Exact Revenue

| | Estimated (MVP) | Exact (Future) |
|---|---|---|
| **Source** | Count of active subscribers × flat price | Sum of actual transaction amounts |
| **Accuracy** | Approximate — assumes all actives paid this month | Precise — only counts real charges |
| **Handles refunds** | No | Yes (negative events) |
| **Handles plan changes** | No (single price assumed) | Yes (actual amount per event) |
| **Use for payouts** | Acceptable for MVP with small ambassador pool | Preferred once billing pipeline exists |

> **MVP payout recommendation:** Use query **2A** (or **2A-alt** if you want the monthly/annual
> split) for ambassador payouts until `billing_events` is populated. Document every payout in a
> spreadsheet or separate `ambassador_payouts` table as an audit trail.

### Recommended `billing_events` Schema

```sql
-- Run this migration when you're ready to track actual transactions.

CREATE TABLE billing_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id),
    event_type      TEXT NOT NULL CHECK (event_type IN (
                        'initial_purchase',
                        'renewal',
                        'upgrade',
                        'downgrade',
                        'refund',
                        'cancellation'
                    )),
    product_id      TEXT NOT NULL,                -- e.g. 'stayreel_pro_monthly'
    amount_usd      NUMERIC(10, 2) NOT NULL,      -- positive for charges, negative for refunds
    currency        TEXT NOT NULL DEFAULT 'USD',
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    rc_transaction_id TEXT,                        -- RevenueCat original_transaction_id
    rc_event_type   TEXT,                          -- raw RC webhook event type
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_events_user   ON billing_events(user_id);
CREATE INDEX idx_billing_events_period ON billing_events(period_start);

COMMENT ON TABLE billing_events IS
    'Transaction-level billing events synced from RevenueCat webhooks. '
    'Used for exact revenue reporting and ambassador payout calculations.';
```

### 3A. Exact Gross Revenue per Ambassador by Month

```sql
-- Requires billing_events table.
-- Returns exact gross revenue (charges minus refunds) per ambassador for the month.

SELECT
    p.referred_by                       AS ambassador_code,
    COUNT(DISTINCT be.user_id)          AS paying_users,
    SUM(be.amount_usd)                  AS gross_revenue
FROM billing_events be
JOIN profiles p ON p.id = be.user_id
WHERE p.referred_by IS NOT NULL
  AND be.period_start >= :month_start
  AND be.period_start <  :month_end
GROUP BY p.referred_by
ORDER BY gross_revenue DESC;
```

### 3B. Exact Gross Revenue per Ambassador + School by Month

```sql
-- Requires billing_events table.
-- Breaks down exact revenue by ambassador and school.

SELECT
    p.referred_by                       AS ambassador_code,
    COALESCE(p.school, '(no school)')   AS school,
    COUNT(DISTINCT be.user_id)          AS paying_users,
    SUM(be.amount_usd)                  AS gross_revenue
FROM billing_events be
JOIN profiles p ON p.id = be.user_id
WHERE p.referred_by IS NOT NULL
  AND be.period_start >= :month_start
  AND be.period_start <  :month_end
GROUP BY p.referred_by, p.school
ORDER BY p.referred_by, gross_revenue DESC;
```

### 3C. Exact Revenue for a Specific Ambassador by Month

```sql
-- Requires billing_events table.
-- Shows every transaction for one ambassador's referred users in the month.

SELECT
    p.id                                AS user_id,
    COALESCE(p.school, '(no school)')   AS school,
    p.referred_at,
    be.event_type,
    be.product_id,
    be.amount_usd,
    be.period_start,
    be.period_end,
    be.created_at                       AS event_created_at
FROM billing_events be
JOIN profiles p ON p.id = be.user_id
WHERE p.referred_by = :ambassador_code
  AND be.period_start >= :month_start
  AND be.period_start <  :month_end
ORDER BY be.created_at;
```

---

## 4. School Breakdown Queries

### 4A. Revenue by School (All Ambassadors)

```sql
-- Returns estimated revenue grouped by school for the fiscal month.
-- Includes both referred and organic users.

SELECT
    COALESCE(p.school, '(no school)')   AS school,
    COUNT(*)                            AS total_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                   AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.referred_by IS NOT NULL
    )                                   AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price                  AS estimated_revenue
FROM profiles p
GROUP BY p.school
ORDER BY estimated_revenue DESC;
```

### 4B. Specific School Drill-Down

```sql
-- For one school and one month: shows each ambassador's contribution.
-- Returns ambassador code, referred users from that school,
-- active paying users, and estimated revenue.

SELECT
    COALESCE(p.referred_by, '(organic)') AS ambassador_code,
    COUNT(*)                              AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                     AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price                    AS estimated_revenue
FROM profiles p
WHERE p.school = :school_name
  AND (p.referred_at IS NULL OR p.referred_at < :month_end)
GROUP BY p.referred_by
ORDER BY estimated_revenue DESC;
```

---

## 5. Monthly Ambassador Leaderboard

### 5A. Leaderboard by Estimated Revenue

```sql
-- Ranks ambassadors for the fiscal month by estimated revenue.
-- Includes rank number, referred users, paying users, and revenue.

SELECT
    RANK() OVER (ORDER BY
        COUNT(*) FILTER (
            WHERE p.subscription_status = 'active'
              AND p.subscription_expires_at >= :month_start
        ) * :monthly_price DESC
    )                                                   AS rank,
    p.referred_by                                       AS ambassador_code,
    COUNT(*)                                            AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                                   AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price                                  AS estimated_revenue
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND p.referred_at < :month_end
GROUP BY p.referred_by
ORDER BY rank;
```

### 5B. Leaderboard by Referred Users (Volume)

```sql
-- Ranks ambassadors by total number of referred sign-ups in the month.

SELECT
    RANK() OVER (ORDER BY COUNT(*) DESC)                AS rank,
    p.referred_by                                       AS ambassador_code,
    COUNT(*)                                            AS referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                                                   AS active_paying_users,
    ROUND(
        COUNT(*) FILTER (
            WHERE p.subscription_status = 'active'
              AND p.subscription_expires_at >= :month_start
        )::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1
    )                                                   AS conversion_rate_pct
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND p.referred_at >= :month_start
  AND p.referred_at <  :month_end
GROUP BY p.referred_by
ORDER BY rank;
```

---

## 6. Specific Ambassador Drill-Down

### 6A. All Referred Users for One Ambassador in One Month

```sql
-- Shows every user referred by :ambassador_code, with their subscription
-- status and whether they count toward this month's payout.

SELECT
    p.id                                                AS user_id,
    COALESCE(p.school, '(no school)')                   AS school,
    p.referred_at,
    p.subscription_status,
    p.subscription_expires_at,
    CASE
        WHEN p.subscription_status = 'active'
         AND p.subscription_expires_at >= :month_start
        THEN TRUE
        ELSE FALSE
    END                                                 AS counts_toward_payout,
    CASE
        WHEN p.subscription_status = 'active'
         AND p.subscription_expires_at >= :month_start
        THEN :monthly_price
        ELSE 0
    END                                                 AS estimated_revenue_contribution
FROM profiles p
WHERE p.referred_by = :ambassador_code
  AND p.referred_at < :month_end
ORDER BY p.referred_at;
```

### 6B. Ambassador Lifetime Summary

```sql
-- Cumulative lifetime stats for one ambassador across all time.
-- Useful for ambassador relationship management.

SELECT
    p.referred_by                                       AS ambassador_code,
    COUNT(*)                                            AS total_referred_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
    )                                                   AS currently_active,
    COUNT(*) FILTER (
        WHERE p.subscription_status IN ('expired', 'cancelled')
    )                                                   AS churned,
    MIN(p.referred_at)                                  AS first_referral,
    MAX(p.referred_at)                                  AS latest_referral,
    COUNT(DISTINCT p.school)                            AS schools_reached
FROM profiles p
WHERE p.referred_by = :ambassador_code
GROUP BY p.referred_by;
```

---

## 7. Unattributed Revenue & Data Quality

### 7A. Paying Users with No Referral Code

```sql
-- Active paying users who were NOT referred by any ambassador.
-- This is your organic revenue — not owed to any ambassador.

SELECT
    p.id,
    COALESCE(p.school, '(no school)')   AS school,
    p.subscription_status,
    p.subscription_expires_at,
    p.created_at
FROM profiles p
WHERE p.subscription_status = 'active'
  AND p.subscription_expires_at >= :month_start
  AND p.referred_by IS NULL
ORDER BY p.created_at;
```

### 7B. Referred Users with Missing School

```sql
-- Users who have a referral code but no school set.
-- You may want to prompt these users to enter a school
-- or investigate whether school attribution is broken.

SELECT
    p.id,
    p.referred_by,
    p.referred_at,
    p.subscription_status,
    p.subscription_expires_at
FROM profiles p
WHERE p.referred_by IS NOT NULL
  AND (p.school IS NULL OR TRIM(p.school) = '')
ORDER BY p.referred_at DESC;
```

### 7C. Suspicious or Malformed Ambassador Codes

```sql
-- Ambassador codes that don't match the expected format (3-30 chars,
-- lowercase alphanumeric + hyphens/underscores) or appear only once
-- (possible typos).

SELECT
    p.referred_by                   AS ambassador_code,
    COUNT(*)                        AS referral_count,
    CASE
        WHEN p.referred_by !~ '^[a-z0-9_-]{3,30}$'
        THEN 'malformed'
        WHEN COUNT(*) = 1
        THEN 'single_use (possible typo)'
        ELSE 'ok'
    END                             AS flag
FROM profiles p
WHERE p.referred_by IS NOT NULL
GROUP BY p.referred_by
HAVING p.referred_by !~ '^[a-z0-9_-]{3,30}$'
   OR COUNT(*) = 1
ORDER BY referral_count;
```

### 7D. Revenue Attribution Summary

```sql
-- High-level split: how much estimated revenue is attributed vs organic.

SELECT
    CASE
        WHEN p.referred_by IS NOT NULL THEN 'attributed'
        ELSE 'organic'
    END                             AS attribution,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    )                               AS active_paying_users,
    COUNT(*) FILTER (
        WHERE p.subscription_status = 'active'
          AND p.subscription_expires_at >= :month_start
    ) * :monthly_price              AS estimated_revenue
FROM profiles p
GROUP BY
    CASE
        WHEN p.referred_by IS NOT NULL THEN 'attributed'
        ELSE 'organic'
    END
ORDER BY attribution;
```

---

## 8. Recommended Future Schema Improvements

### 8.1 Add `plan_type` to `profiles`

```sql
-- Eliminates the 60-day heuristic for monthly vs annual detection.
-- Populate from the RevenueCat webhook product_id.

ALTER TABLE profiles
    ADD COLUMN plan_type TEXT CHECK (plan_type IN ('monthly', 'annual', 'lifetime'));

COMMENT ON COLUMN profiles.plan_type IS
    'Subscription plan type, synced from RevenueCat webhook product_id.';
```

### 8.2 Create `billing_events` Table

See the schema in [Section 3](#recommended-billing_events-schema) above. Populate it from the
`rc-webhook` edge function by inserting a row on every `INITIAL_PURCHASE`, `RENEWAL`,
`PRODUCT_CHANGE`, and `REFUND` event.

### 8.3 Create `ambassador_payouts` Audit Table

```sql
-- Records every payout made to ambassadors for audit and dispute resolution.

CREATE TABLE ambassador_payouts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ambassador_code TEXT NOT NULL,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    referred_users  INT NOT NULL,
    paying_users    INT NOT NULL,
    gross_revenue   NUMERIC(10, 2) NOT NULL,
    payout_amount   NUMERIC(10, 2) NOT NULL,
    payout_pct      NUMERIC(5, 2) NOT NULL,           -- e.g. 20.00 for 20%
    method          TEXT,                               -- 'venmo', 'paypal', 'check'
    notes           TEXT,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ambassador_payouts_code
    ON ambassador_payouts(ambassador_code, period_start);
```

### 8.4 Create `ambassadors` Registry Table

```sql
-- Central registry of ambassador codes, contact info, and commission rate.
-- Allows you to validate codes at entry time and customize payout rates.

CREATE TABLE ambassadors (
    code            TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9_-]{3,30}$'),
    display_name    TEXT NOT NULL,
    email           TEXT,
    instagram       TEXT,
    school          TEXT,
    commission_pct  NUMERIC(5, 2) NOT NULL DEFAULT 20.00,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ambassadors IS
    'Registry of ambassador codes. Used for code validation, '
    'contact info, and per-ambassador commission rates.';
```

### 8.5 Summary of Recommended Improvements

| Priority | Improvement | Effort | Impact |
|---|---|---|---|
| **P0** | `billing_events` table + RC webhook writes | 2-3 hrs | Enables exact revenue queries |
| **P1** | `ambassador_payouts` audit table | 1 hr | Audit trail for every payout |
| **P1** | `plan_type` column on `profiles` | 30 min | Accurate monthly/annual split |
| **P2** | `ambassadors` registry table | 1 hr | Code validation, contact info, custom rates |
| **P2** | Supabase dashboard/view for monthly reports | 2 hrs | Self-serve reporting without raw SQL |

---

## Quick-Start: Running Your First Payout Report

1. Open the **Supabase SQL Editor**
2. Paste query **2A** (Ambassador Monthly Summary)
3. Replace `:month_start` with `'2026-03-01'`, `:month_end` with `'2026-04-01'`, `:monthly_price` with `3.99`
4. Run — you'll see each ambassador's referred users, paying users, and estimated revenue
5. Apply your commission rate (e.g. 20%) to `estimated_revenue` to get the payout amount
6. Record the payout in a spreadsheet (or the `ambassador_payouts` table once created)

---

*Generated for StayReel — update queries as schema evolves.*
