const { withPlugins } = require('@expo/config-plugins');

/**
 * Config plugin to extract iosUrlScheme from webClientId for Google Sign-In
 * 
 * The iosUrlScheme must be in format: com.googleusercontent.apps.{client-id-suffix}
 * Web Client ID format: {numbers}-{suffix}.apps.googleusercontent.com
 */
function withGoogleSignInConfig(config) {
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  
  if (!webClientId) {
    console.warn('⚠️ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID not set, skipping Google Sign-In plugin configuration');
    return config;
  }

  // Extract the suffix from webClientId
  // Format: {numbers}-{suffix}.apps.googleusercontent.com
  // We need: com.googleusercontent.apps.{suffix}
  const match = webClientId.match(/^[\d]+-([^.]+)\.apps\.googleusercontent\.com$/);
  
  if (!match) {
    console.warn(`⚠️ Invalid webClientId format: ${webClientId}. Expected format: {numbers}-{suffix}.apps.googleusercontent.com`);
    return config;
  }

  const clientIdSuffix = match[1];
  const iosUrlScheme = `com.googleusercontent.apps.${clientIdSuffix}`;

  // Use withPlugins to add the Google Sign-In plugin with correct configuration
  return withPlugins(config, [
    [
      '@react-native-google-signin/google-signin',
      {
        webClientId,
        iosUrlScheme,
      },
    ],
  ]);
}

module.exports = withGoogleSignInConfig;

