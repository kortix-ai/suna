for (const key of Object.keys(process.env)) {
  const value = process.env[key];
  if (typeof value === 'string' && value.startsWith('encrypted:')) {
    delete process.env[key];
  }
}

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key-not-a-real-secret';
process.env.NEXT_PUBLIC_BACKEND_URL ||= 'http://localhost:8008/v1';
process.env.NEXT_PUBLIC_APP_URL ||= 'http://localhost:3000';
process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ||= 'http://localhost:8008';
process.env.NEXT_PUBLIC_BILLING_ENABLED ||= 'false';
