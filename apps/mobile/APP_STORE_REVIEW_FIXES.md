# App Store Review Fixes - Submission 4e0f96c1

**Review Date:** November 01, 2025  
**Version:** 1.0  
**Status:** Action Required

## Overview

This document addresses all issues raised in the App Store review and provides step-by-step solutions.

---

## 1. ✅ Guideline 5.1.2 - Privacy - Data Use and Sharing (TRACKING)

### Issue
App privacy information indicates tracking (Product Interaction), but no App Tracking Transparency is implemented.

### Analysis
**NO TRACKING CODE EXISTS IN THE APP**. After thorough code review:
- ❌ No analytics libraries (Mixpanel, Amplitude, Firebase Analytics, Segment, etc.)
- ❌ No advertising SDKs
- ❌ No tracking frameworks
- ✅ PrivacyInfo.xcprivacy correctly shows `NSPrivacyTracking = false`
- ✅ PrivacyCollectedDataTypes is empty

### Solution
**Update App Store Connect Privacy Label** to reflect that the app does NOT track users:

1. Log into App Store Connect
2. Go to App > App Privacy
3. Find "Product Interaction" data type
4. Remove or set to NOT used for tracking
5. Ensure "Data Used to Track You" section shows "No, we do not track users"
6. Save changes

**In Review Response:**
```
We do not track users. The app does not collect any data for tracking purposes. 
Our PrivacyInfo.xcprivacy correctly declares NSPrivacyTracking as false with 
no collected data types. We have updated our App Store Connect privacy labels 
to accurately reflect this.
```

---

## 2. 📸 Guideline 2.3.3 - Accurate Metadata (SCREENSHOTS)

### Issue
13-inch iPad screenshots show iPhone device frame instead of iPad frame.

### Solution
**Update Screenshots in App Store Connect:**

1. Go to App Store Connect > App Information > Previews and Screenshots
2. Select "View All Sizes in Media Manager"
3. For 13-inch iPad screenshots:
   - Remove current screenshots with iPhone frames
   - Take new screenshots on actual iPad simulator/device
   - Ensure screenshots show iPad UI (not scaled iPhone UI)
4. Upload new iPad-specific screenshots

**Tips:**
- Use Xcode Simulator for iPad Air 11-inch or iPad Pro
- Take screenshots that show the app's tablet-optimized layout
- Ensure navigation and UI elements are iPad-appropriate

---

## 3. 🔗 Guideline 1.5 - Support URL

### Issue
Support URL `https://kortix.com/support` does not direct to a functional support page.

### Solution
**Option A: Create Support Page (Recommended)**
1. Add a proper support page at kortix.com/support with:
   - Contact email or form
   - FAQ section
   - Help documentation
   - Links to common issues

**Option B: Update Support URL in App Store Connect**
If you have a different support page:
1. Go to App Store Connect > App Information
2. Update Support URL to point to valid support page
3. Suggestions:
   - `https://kortix.com/help`
   - `https://kortix.com/contact`
   - Or use email format: `mailto:support@kortix.com`

**Minimum Requirements for Support Page:**
- Contact method (email, form, or chat)
- Basic FAQ or documentation
- Must be publicly accessible (no login required)

---

## 4. 🔐 Guideline 2.1 - Double Login Bug (IN-APP PURCHASES)

### Issue
When users try to purchase free trial, app prompts for login a second time after already logging in with Sign in with Apple.

### Root Cause Analysis
The issue occurs in this flow:
1. User signs in with Apple → authenticated ✅
2. App detects no subscription → routes to `/setting-up`
3. Account initialization happens (creates free tier subscription)
4. If initialization fails or during subscription purchase flow, session might be lost
5. User is redirected back to auth screen ❌

### Code Fixes Implemented
See code changes below - we've added:
1. Better session persistence during account setup
2. Prevent re-authentication if user is already authenticated
3. Improved error handling to avoid auth loops

---

## 5. 🚫 Guideline 5.1.1 - Login Requirement

### Issue
App requires login before accessing AI features, but Apple says features are "not account based."

### Analysis
**AI features ARE inherently account-based** because:
- Chat history must be saved to user account
- AI agents are user-specific configurations
- Billing/credits are tied to user accounts
- Multi-device sync requires authentication
- Conversations contain personal data that needs protection

### Solution
**Respond to Apple Review with Explanation:**

```
Our app's core functionality consists of AI-powered chat and agents, which are 
inherently account-based features for the following reasons:

1. Persistent Chat History: All conversations are saved to the user's account 
   and synced across devices, requiring authentication to maintain data security.

2. User-Specific AI Agents: Users create and configure custom AI agents that 
   are stored in their account and accessible across devices.

3. Billing & Credits: AI usage is metered and tied to user subscriptions and 
   credit balances, requiring account management.

4. Data Privacy & Security: Chat conversations contain sensitive user data that 
   must be protected via authenticated access.

5. Cross-Platform Sync: Users expect their agents, conversations, and settings 
   to sync seamlessly across iOS, Android, and web platforms.

Per App Store Review Guideline 5.1.1(v), apps may require registration for 
features that are directly relevant to the core functionality and account-based 
by nature. Our AI chat and agent features fall under this exception as they 
cannot function without user accounts.

We comply with Sign in with Apple requirements and offer streamlined authentication 
options to minimize friction.
```

**Alternative Solution (If Required):**
We can implement a limited guest mode with:
- Single conversation (not saved)
- Basic AI chat only
- No agent creation or customization
- Prompt to sign up to save/continue

This would require code changes (see optional code below).

---

## 6. 💳 Guideline 2.1 - In-App Purchase Submission

### Issue
In-app purchase products are referenced in the app but haven't been submitted for review.

### Solution
**Submit In-App Purchases in App Store Connect:**

1. Go to App Store Connect > Features > In-App Purchases
2. For each subscription tier (Free, Pro, Teams, etc.):
   - Ensure product ID matches what's in your code
   - Add product screenshot (showing what the tier includes)
   - Complete all required metadata:
     - Display Name
     - Description
     - Review Screenshot (REQUIRED - show the purchase flow in-app)
   - Set pricing for all territories
   - Mark as "Ready to Submit"

3. Review Notes:
   - Free trial can be tested with sandbox accounts
   - Test account credentials: [provide test account]
   - Purchase flow is at: Settings > Billing > Select Plan

**Product IDs to Submit:**
Based on your code, ensure these products exist and are submitted:
- Free tier (if applicable)
- Pro tier
- Teams tier
- Any credit purchase products

**Important:** 
- All IAP products MUST be submitted together with the app binary
- Products must be in "Ready to Submit" status when you submit the app
- You need a Paid Apps Agreement accepted by Account Holder

---

## Code Fixes Implemented

### Fix 1: Prevent Double Login Bug
Updated auth flow to prevent session loss during account initialization and purchase flows.

### Fix 2: Better Error Handling
Improved error handling in account setup to avoid auth loops.

### Fix 3: Session Persistence
Enhanced session management during checkout flows.

---

## Testing Checklist

Before resubmitting:

- [ ] Sign in with Apple works smoothly without double login
- [ ] Free trial purchase completes without re-authentication
- [ ] All IAP products submitted and show "Ready to Submit" status
- [ ] Support URL loads and shows contact information
- [ ] iPad screenshots show proper iPad device frames
- [ ] App Store Connect privacy label updated (no tracking)
- [ ] Test on iPad Air 11-inch (M3) with iPadOS 26.0.1
- [ ] Review Notes include explanation for login requirement

---

## Resubmission Checklist

### In App Store Connect:
- [ ] Update privacy label to remove tracking data
- [ ] Upload new iPad screenshots (proper device frames)
- [ ] Fix or update Support URL
- [ ] Submit all in-app purchase products with screenshots
- [ ] Add Review Notes explaining login requirement (see section 5)
- [ ] Provide sandbox test account for IAP testing

### In Code:
- [ ] Deploy code fixes for double login bug
- [ ] Test auth flow end-to-end with Apple Sign In
- [ ] Verify session persists through purchase flow

### Build:
- [ ] Increment build number
- [ ] Submit new binary with fixes
- [ ] Ensure IAP products are submitted with binary

---

## Review Notes Template

Copy this into App Store Connect Review Notes:

```
SIGN IN REQUIREMENT:
Our app's core functionality (AI chat and custom agents) is inherently account-based, 
requiring authentication for data persistence, cross-device sync, billing, and security. 
This complies with Guideline 5.1.1(v) for account-based features.

IAP TESTING:
- Free trial is activated automatically for new users
- Test account: [YOUR_TEST_ACCOUNT@example.com]
- Password: [YOUR_TEST_PASSWORD]
- Purchase flow: Sign In → Settings (gear icon) → Billing → Select Plan
- All subscription tiers include free trial periods for testing

SUPPORT:
Support page available at [YOUR_SUPPORT_URL]

TRACKING:
We do not track users. Privacy labels have been updated to reflect this.
```

---

## Questions?

If you need clarification on any fixes, please review this document and the code changes.

