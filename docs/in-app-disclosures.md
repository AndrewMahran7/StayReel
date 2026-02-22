# In-App Disclosure Strings

Copy these strings into the relevant UI components.

---

## Connect Instagram Screen

### Security banner (shown above the cookie field)
> 🔒 **Your cookie is encrypted, never your password.**
> StayReel only needs your Instagram session cookie — not your password.
> It is encrypted with AES-256 and used solely to fetch your own follower list.
> It is never logged, shared, or visible to anyone, including us.

### Cookie field label hint (below the input)
> Paste the value of the `sessionid` cookie from instagram.com.
> Open a desktop browser → instagram.com → DevTools → Application → Cookies.

### Warning banner (shown below security banner)
> ⚠️ **Only connect accounts you own.**
> Using StayReel to track someone else's account or for bulk data collection
> violates Instagram's Terms of Service and may result in your account being restricted.

---

## First Launch / Consent Modal

### Title
> Personalised Ads

### Body
> StayReel is free and supported by ads.
> We'd like to show you personalised ads based on your interests.
> Tap **Accept** to consent, or **Decline** for non-personalised ads.
> You can change this at any time in Settings.

### Decline button label
> Decline (non-personalised ads)

### Accept button label
> Accept personalised ads

---

## Settings Screen

### Disconnect Instagram row subtitle
> Removes your session token. Snapshot history is kept.

### Delete All My Data row subtitle
> Permanently deletes snapshots, diffs, and your account. Cannot be undone.

### Personalised Ads toggle label
> Allow Google AdMob to use your ad identifier for personalised ads.

### Ad-free period active state
> Ads removed until [DATE] — earned by watching a rewarded video.

---

## Data Deletion Confirmation Alert

### Title
> Delete All My Data?

### Message
> This will permanently delete:
> • Your email account
> • Your connected Instagram account
> • All follower snapshots and statistics
>
> This cannot be undone. Are you sure?

### Cancel button
> Cancel

### Confirm button (destructive)
> Delete everything

---

## Onboarding / About Page (optional)

> **How it works:**
> 1. You paste your Instagram session cookie — no password required.
> 2. StayReel periodically fetches your follower list (max twice per day).
> 3. We compute diffs and show you who joined, who left, and who doesn't follow back.
> 4. Raw follower data is deleted after 30 days. Your statistics stay unless you delete your account.
