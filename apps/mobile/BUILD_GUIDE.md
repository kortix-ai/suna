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

**App Store version** → Edit `app.json` line 5:
```json
"version": "1.2.0"
```

**Build numbers** → Auto-managed by EAS (remote)

| What | How |
|------|-----|
| New App Store release | Bump `version` in `app.json` |
| Build numbers | Automatic (1, 2, 3...) |
| Check current version | `eas build:version:get -p ios` |

## OTA Updates

**Auto-publishes** on push to `main`, `staging`, `production`
- Only works for JS/TS changes
- Users get updates instantly

**Manual publish:**
```bash
eas update --branch main --message "Update" --platform ios
eas update --branch main --message "Update" --platform android
```
