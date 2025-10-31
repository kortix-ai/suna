# Expo React Native Boilerplate

A clean, production-ready Expo/React Native boilerplate with authentication, billing, and internationalization.

## Features

### ✅ Included
- **Authentication** - Complete auth flow with Supabase
- **Billing Integration** - Subscription and credit-based billing system
- **Internationalization** - Multi-language support (i18next)
- **Navigation** - Expo Router with file-based routing
- **UI Components** - Pre-built components with NativeWind (Tailwind CSS)
- **State Management** - React Query for server state
- **TypeScript** - Full type safety
- **Onboarding Flow** - User onboarding screens
- **Settings** - Account management, theme, language selection

### ❌ Removed
This boilerplate has been cleaned of all AI-specific features:
- AI Agents
- Chat/Thread functionality
- Sandboxes
- Knowledge bases
- Triggers
- File attachments for AI
- Voice/audio features

## Project Structure

```
Expo/
├── app/                    # Expo Router screens
│   ├── auth/              # Authentication screens
│   ├── index.tsx          # Splash/routing screen
│   ├── home.tsx           # Main home screen
│   └── onboarding.tsx     # Onboarding flow
├── components/            # React components
│   ├── ui/               # Reusable UI components
│   ├── auth/             # Auth-specific components
│   ├── billing/          # Billing components
│   ├── settings/         # Settings screens
│   └── shared/           # Shared utilities
├── contexts/             # React contexts
│   ├── AuthContext.tsx   # Authentication state
│   ├── BillingContext.tsx # Billing state
│   └── LanguageContext.tsx # i18n state
├── hooks/                # Custom React hooks
│   ├── ui/               # UI-related hooks
│   ├── useAuth.ts        # Auth hook
│   └── useOnboarding.ts  # Onboarding hook
├── lib/                  # Core library code
│   ├── billing/          # Billing API & hooks
│   └── utils/            # Utility functions
├── api/                  # API configuration
├── providers/            # App-level providers
├── locales/              # Translation files
├── assets/               # Images, fonts, etc.
└── package.json          # Dependencies
```

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn
- Expo CLI

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables (create `.env` file):
```env
EXPO_PUBLIC_SUPABASE_URL=your_supabase_url
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

3. Start the development server:
```bash
npm run dev
```

### Running on Devices

- **iOS**: `npm run ios`
- **Android**: `npm run android`
- **Web**: `npm run web`

## Customization

### Update Branding
1. Change app name in `app.json`
2. Replace logo/icons in `assets/`
3. Update colors in `tailwind.config.js`

### Add Features
This is a clean slate boilerplate. Build your app by:
1. Adding new screens in `app/`
2. Creating components in `components/`
3. Adding API calls in `lib/`
4. Managing state with contexts or React Query

### Backend
The boilerplate uses Supabase for:
- Authentication
- Database
- Real-time features (optional)

You can swap Supabase for another backend by updating the `api/` folder.

## Available Scripts

- `npm run dev` - Start Expo development server
- `npm run android` - Run on Android
- `npm run ios` - Run on iOS
- `npm run web` - Run on web
- `npm run clean` - Clean build cache

## Tech Stack

- **Framework**: Expo / React Native
- **Language**: TypeScript
- **Styling**: NativeWind (Tailwind CSS)
- **Navigation**: Expo Router
- **State**: React Query
- **Backend**: Supabase
- **i18n**: i18next

## License

This is a boilerplate template - use it however you want!

## Support

For issues or questions, please refer to:
- [Expo Documentation](https://docs.expo.dev)
- [React Native Documentation](https://reactnative.dev)
- [Supabase Documentation](https://supabase.com/docs)
