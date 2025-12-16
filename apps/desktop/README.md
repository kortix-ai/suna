# Kortix Desktop

Minimal Electron wrapper for the Kortix web application with deep linking support.

## Features

- Native macOS/Windows/Linux desktop app
- Deep linking for magic link authentication (`kortix://` protocol)
- Integrated navigation controls (back, forward, reload, copy URL)
- Keyboard shortcuts (Cmd+Left/Right, Cmd+R, Cmd+Shift+C)

## Development

```bash
npm install
npm start
```

## Building

Build for your platform:

```bash
npm run build:mac          # macOS (with signing if .env exists)
npm run build:mac:unsigned # macOS (quick, no signing)
npm run build:win          # Windows
npm run build:linux        # Linux
```

Or build for all platforms:

```bash
npm run build
```

**Note:** For signed macOS builds, create a `.env` file with Apple credentials (see `LOCAL-BUILD.md`).

## Configuration

Set `APP_URL` environment variable to load a different URL:

```bash
APP_URL=http://localhost:3000 npm start
```

By default, it loads `https://kortix.com/`.

## Installation

For end users, see [INSTALLATION.md](./INSTALLATION.md) for detailed installation instructions including how to bypass macOS Gatekeeper on first launch.

## Deep Linking

The app registers the `kortix://` protocol for magic link authentication:

1. User enters email in desktop app
2. Magic link email contains `kortix://auth/callback?code=xxx`
3. User clicks link in email
4. Operating system opens Kortix Desktop app
5. App handles auth callback and logs user in

The protocol is automatically registered when the app is installed.

## Code Signing Status

The CI/CD builds use **ad-hoc code signing** which means:
- ✅ App is properly signed and not "damaged"
- ⚠️ Not notarized with Apple (requires paid developer account)
- 📝 Users must right-click → Open on first launch (macOS only)

For production notarization, add Apple Developer credentials to GitHub Secrets.
