# Kortix Mobile App - Build & Deploy Guide

## 📱 Quick Start

### Prerequisites
- Node.js installed
- EAS CLI installed globally: `npm install -g eas-cli`
- Logged into Expo account: `eas login`
- Apple Developer account access

---

## 🔢 Build Number & Version Management

### Where to change version info:

**File: `apps/mobile/app.json`**

- **App Version** (Line 5): `"version": "1.0.0"` - This is your app version (update for major releases)

**Important:** Build numbers are managed automatically by EAS. You don't need to manually update them!

---

## 🚀 Build Commands

### ⚡ Expo Go Testing (SIMPLEST)

**The fastest way to test with your team - works just like development!**

```bash
cd apps/mobile

# Using BRANCHES (tied to git branches)
eas update --branch main --message "Test build for team" --platform ios

# For Android testing
eas update --branch main --message "Test build for team" --platform android
```

**Then share with your team:**

**Option 1: Direct URL (Easiest)**
1. After publishing, you'll get a URL like: `exp://u.expo.dev/...`
2. Share this URL with your team
3. Team members:
   - Install **Expo Go** app from App Store (if not already installed)
   - Open the URL on their iPhone (tap it, or paste in Safari and it will open Expo Go)
   - App loads instantly! 🎉

**Option 2: QR Code**
1. Visit your Expo dashboard: `https://expo.dev/accounts/kortix/projects/kortix`
2. Find your published update
3. Share the QR code with your team
4. They scan it with Expo Go app

**Note:** Some native features (like Apple Sign In) may have limitations in Expo Go, but most features work perfectly for testing.

---

### 🤖 Automatic Updates via CI/CD

**Auto-publish EAS updates whenever you push to git!**

We have a GitHub Actions workflow (`.github/workflows/mobile-eas-update.yml`) that automatically publishes EAS updates when you push to `main`, `staging`, or `production` branches.

**Setup (one-time):**
1. Get your Expo access token:
   - Visit: https://expo.dev/accounts/kortix/settings/access-tokens
   - Create a new token (or use existing one)
2. Add it as a GitHub secret:
   - Go to your GitHub repo → Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `EXPO_TOKEN`
   - Value: Your Expo access token

**How it works:**
- ✅ Automatically runs on push to `main`, `staging`, or `production` branches
- ✅ Only triggers when files in `apps/mobile/` change
- ✅ Publishes to iOS by default (can be configured)
- ✅ Uses the git branch name as the EAS branch
- ✅ Includes commit message and SHA in the update message

**Manual trigger:**
You can also manually trigger the workflow from GitHub Actions tab with custom branch/platform options.

---

### TestFlight Build (For TestFlight distribution)

```bash
cd apps/mobile

# Just build
eas build --profile testflight --platform ios

# Build AND submit to TestFlight automatically
eas build --profile testflight --platform ios --auto-submit
```

### Production Build (For App Store release)

```bash
cd apps/mobile

# Just build
eas build --profile production --platform ios

# Build AND submit automatically
eas build --profile production --platform ios --auto-submit
```

### Submit Separately (After build completes)

**For TestFlight:**
```bash
cd apps/mobile
eas submit --profile testflight --platform ios
```

**For Production/App Store:**
```bash
cd apps/mobile
eas submit --profile production --platform ios
```

---

## 📋 Complete Workflow: First Time Setup

### 1. Navigate to mobile directory
```bash
cd apps/mobile
```

### 2. Login to Expo (if not already)
```bash
eas login
```

### 3. Start the build
```bash
eas build --profile testflight --platform ios
```

### 4. Follow the prompts (if first time)
- Say **YES** when asked to log in to your Apple account
- Enter Apple ID: `mkprivat2005@gmail.com`
- Select team when prompted
- Wait for credentials to sync

### 5. Wait for build
- Build runs in the cloud
- Takes up to ~XX minutes
- Watch progress in terminal or visit the provided URL

---

## 🎯 Common Commands Reference

### Check build status
```bash
eas build:list
```

### View specific build details
```bash
eas build:list --id <BUILD_ID>
```

### Cancel a build
```bash
eas build:cancel <BUILD_ID>
```

### View build logs
Visit the URL provided in the terminal output

---


## 📝 Build Profiles Explained

Located in: `apps/mobile/eas.json`

- **expo-internal**: For Expo internal distribution (fast testing)
  - Profile: Lines 38-50
  - Distribution: `internal` (no App Store review)
  - Best for: Quick testing iterations

- **testflight**: For TestFlight distribution
  - Profile: Lines 25-37
  - Submit config: Lines 47-53
  - Distribution: `store` (requires TestFlight review)

- **production**: For App Store release
  - Profile: Lines 14-24
  - Submit config: Lines 40-46
  - Distribution: App Store

- **preview**: For internal testing
  - Profile: Lines 11-13
  - Distribution: `internal`

- **development**: For dev client builds
  - Profile: Lines 7-10
  - Uses `.env` file locally (not included in builds)


