import { Platform } from 'react-native';

// Get the backend URL from environment variables (already includes /api)
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:8000/api';

// Handle React Native localhost issues
const getServerUrl = (): string => {
  let serverUrl = BACKEND_URL;
  
  if (Platform.OS === 'web') {
    return serverUrl;
  }
  
  // For React Native, replace localhost with the appropriate hostname
  if (serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1')) {
    serverUrl = serverUrl.replace('localhost', 'vukasin.local').replace('127.0.0.1', 'vukasin.local');
  }
  
  return serverUrl;
};

export const SERVER_URL = getServerUrl();
