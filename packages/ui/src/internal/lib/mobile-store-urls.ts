/**
 * Canonical store URLs: no storefront country (`/cg/`) and no `hl=` locale.
 * Each store picks the visitor's own region and language. Its own module so
 * the project page's mobile-app introduction reads them without pulling the
 * download page's catalog into the app chunk.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/kortix/id6754448524';
export const GOOGLE_PLAY_URL =
  'https://play.google.com/store/apps/details?id=com.kortix.application';
