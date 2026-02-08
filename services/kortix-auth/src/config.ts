export const config = {
  PORT: parseInt(process.env.PORT || '8009', 10),
  ENV_MODE: process.env.ENV_MODE || 'local',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET || '',

  // API Key secret for HMAC-SHA256 hashing
  API_KEY_SECRET: process.env.API_KEY_SECRET || '',

  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  isLocal(): boolean {
    return this.ENV_MODE === 'local';
  },

  isDevelopment(): boolean {
    return this.ENV_MODE === 'local' || this.ENV_MODE === 'staging';
  },
};
