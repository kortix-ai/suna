# Mobile Build Guide

## Setup
```bash
pnpm install -g eas-cli
eas login
```

## Android Development Setup

**Default workflow (cloud build - recommended):**
```bash
cd apps/mobile
pnpm run android:setup
pnpm run android:build    
pnpm run android:dev      
```

## IOS Development Setup
```bash
cd apps/mobile
npx expo run:ios  
```

## Build & Submit

**Production (iOS - App Store):**
```bash
cd apps/mobile
eas build --profile production --platform ios --auto-submit
```

**Production (Android - Play Store):**
```bash
eas build --profile production --platform android --auto-submit
```

**TestFlight (iOS):**
```bash
eas build --profile testflight --platform ios --auto-submit
```

**TestFlight (Android):**
```bash
eas build --profile testflight --platform android --auto-submit
```

## Version Management

**For new App Store release, update ALL 3 files:**

```bash
# 1. app.json (line 5)
"version": "1.1.1"

# 2. ios/Kortix/Info.plist (CFBundleShortVersionString - line 24)
<string>1.1.1</string>

# 3. android/app/build.gradle (versionName - line 96)
versionName "1.1.1"
```

**Important:** All 3 files must match exactly, or the build will use the wrong version!

**Build numbers** → Auto-managed by EAS (remote)

| What | How |
|------|-----|
| New App Store release | Bump version in all 3 files above |
| Build numbers | Automatic (71, 72, 73...) |
| Check current version | `eas build:version:get -p ios` |

## OTA Updates

**Auto-publishes** on push to `main`, `staging`, `production`
- Only works for JS/TS changes
- Users get updates instantly

**Manual publish (if needed):**
```bash
cd apps/mobile
eas update --branch main --message "Update" --platform ios
eas update --branch main --message "Update" --platform android
```
