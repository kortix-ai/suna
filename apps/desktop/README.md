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
npm run build:mac      # macOS
npm run build:win      # Windows
npm run build:linux    # Linux
```

Or build for all platforms:

```bash
npm run build
```

## Configuration

Set `APP_URL` environment variable to load a different URL:

```bash
APP_URL=http://localhost:3000 npm start
```

By default, it loads `https://kortix.com/`.

## Deep Linking

The app registers the `kortix://` protocol for magic link authentication:

1. User enters email in desktop app
2. Magic link email contains `kortix://auth/callback?code=xxx`
3. User clicks link in email
4. Operating system opens Kortix Desktop app
5. App handles auth callback and logs user in

The protocol is automatically registered when the app is installed.
