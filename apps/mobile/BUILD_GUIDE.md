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

### TestFlight Build (Recommended for testing)

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

- **testflight**: For TestFlight distribution
  - Profile: Lines 20-26
  - Submit config: Lines 36-42

- **production**: For App Store release
  - Profile: Lines 14-19
  - Submit config: Lines 29-35

- **preview**: For internal testing
  - Profile: Lines 11-13

- **development**: For dev client builds
  - Profile: Lines 7-10
  - Uses `.env` file locally (not included in builds)


