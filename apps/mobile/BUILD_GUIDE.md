# Mobile Build Guide

## Setup
```bash
npm install -g eas-cli
eas login
```

## Android Development Setup
```bash
cd apps/mobile
npm run android:setup
npm run android:build
npm run android:dev
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

**Set version** (when you want new release):
```bash
# iOS
eas build:version:set --platform ios
# Enter version: 1.1.0

# Android
eas build:version:set --platform android
# Enter version: 1.1.0
```

**Check version:**
```bash
eas build:version:get --platform ios
eas build:version:get --platform android
```

- Versions stored on EAS (remote)
- Build numbers auto-increment
- Update version only for new releases

## OTA Updates

**Auto-publishes** on push to `main`, `staging`, `production`
- Only works for JS/TS changes
- Users get updates instantly

**Manual publish:**
```bash
eas update --branch main --message "Update" --platform ios
eas update --branch main --message "Update" --platform android
```
