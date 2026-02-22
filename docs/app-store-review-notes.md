# App Store Review Notes

Paste into the "Notes" field of App Store Connect when submitting for review.
Keep your submission under ~1000 characters in the field; the full version is here for your records.

---

## Short Version (paste into App Store Connect)

```
StayReel helps users track their own Instagram follower changes over time.

INSTAGRAM ACCESS:
The app does not use any official Instagram API. Users manually copy their
own Instagram session cookie (sessionid) from a desktop browser and paste it
into the app. No Instagram password is entered. The cookie is encrypted
(AES-256) and used only to fetch the user's own follower/following lists.
There is no automated login, no OAuth flow, and no Instagram credentials are
stored in plaintext.

TEST ACCOUNT:
A test account is not required — sign in with any email address. A magic link
will be sent to that email. To test the Instagram connection, paste any
syntactically valid session cookie string into the field; the app will attempt
to authenticate and show an error if the cookie is invalid.

DEMO CREDENTIALS (if needed):
Email: reviewer@stayreel.app
(A magic link will be dispatched; alternatively request a test session via
privacy@stayreel.app)

ADS:
The app uses Google AdMob. ATT prompt is shown before any ad identifier is
accessed. Consent can be declined; non-personalised ads are shown instead.
```

---

## Full Version (for your own records / legal reference)

### What the app does
StayReel is an Instagram follower tracking utility. Users connect their own
Instagram account and the app fetches their follower/following list to detect
changes (new followers, unfollows, non-reciprocal follows). No other user's
account is accessed. The app is not a social network and users cannot interact
with Instagram content through it.

### Why there is no OAuth / official API
Instagram deprecated its Basic Display API in late 2024. The app uses the same
mobile API endpoint that the official Instagram app uses, authenticated via the
user's own session cookie (which the user copies manually from their browser).
This is consistent with how many personal data tools operate, similar to how
users export their own data. The user is required to have an existing Instagram
account and to obtain their own session cookie independently.

### Why the session cookie is requested
The session cookie (`sessionid`) is the standard mechanism for authenticated
requests to Instagram's API. The user copies it from their browser's developer
tools — no credentials are typed into the app. This is prominently disclosed
on the connection screen with security banners and a step-by-step help modal.

### Data privacy
- Session cookies are encrypted at rest with AES-256 (Supabase Vault).
- Follower usernames are deleted after 30 days.
- Users can delete all their data from Settings at any time.
- No data is sold or shared with third parties except the ad network (AdMob).

### Advertising and ATT
- The app shows Google AdMob ads.
- The system ATT prompt is triggered before any personalised ad is served.
- Users who decline ATT/consent receive non-personalised ads.
- "Remove ads for 7 days" is available via a rewarded video ad (no IAP).

### Guideline references
- **4.2 Minimum Functionality:** The app provides meaningful value — tracking
  follower changes over time with computed statistics, lists, and history.
- **5.1.1 Data Collection:** Disclosed in Privacy Policy linked in the app and
  in the App Store listing. ATT prompt is shown before ad ID access.
- **4.3 Spam:** Single-purpose utility; no duplicate functionality.

### How to test without an Instagram account
You do not need a real Instagram cookie to review the app. You can:
1. Sign in with any email — the magic link flow is the core auth path.
2. On the Connect Instagram screen, the UI, warnings, and help modal are all
   accessible without submitting.
3. If you need a live demo, contact privacy@stayreel.app for a pre-seeded
   test account with existing snapshot data.

---

## App Store Listing — Privacy Nutrition Label

| Data Type | Collected | Linked to Identity | Used for Tracking |
|---|---|---|---|
| Email address | Yes | Yes | No |
| User ID (internal) | Yes | Yes | No |
| Device ID (IDFA) | Yes (if consent granted) | No | Yes (AdMob, consent-gated) |
| Usernames (IG followers) | Yes | Yes | No |
| Coarse location | No | — | — |
| Precise location | No | — | — |
| Contacts | No | — | — |
| Browsing history | No | — | — |
| Purchase history | No | — | — |
| Health data | No | — | — |
