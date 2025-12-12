# Kortix Mobile - Build Guide

## Quick Start

### Prerequisites
- Node.js
- EAS CLI: `npm install -g eas-cli`
- Expo account: `eas login`

### Android Development

```bash
cd apps/mobile
npm run android:setup
npm run android:build
npm run android:dev
```

## Build Commands

### EAS Update (Expo Go)
```bash
cd apps/mobile
eas update --branch main --message "Update" --platform ios
eas update --branch main --message "Update" --platform android
```

### TestFlight Build (iOS)
```bash
cd apps/mobile
eas build --profile testflight --platform ios --auto-submit
```

### Production Build (iOS)
```bash
cd apps/mobile
eas build --profile production --platform ios --auto-submit
```

### Android Production Build
```bash
cd apps/mobile
eas build --profile production --platform android --auto-submit
```

### Submit Separately
```bash
eas submit --profile testflight --platform ios
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

## Version Management

Edit `apps/mobile/app.json` line 5: `"version": "1.0.0"`

Build numbers are auto-managed by EAS.

## CI/CD

**EAS Updates:** Auto-publishes on push to `main`, `PRODUCTION`  
**TestFlight Builds:** Auto-builds on push to `main`, `PRODUCTION`

Setup: Add `EXPO_TOKEN` to GitHub Secrets.

## Build Profiles

- **testflight**: TestFlight distribution
- **production**: App Store release
- **development**: Dev client builds
- **preview**: Internal testing

Config: `apps/mobile/eas.json`
