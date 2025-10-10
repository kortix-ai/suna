import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://your-project.supabase.co'; // Replace with your Supabase project URL
const supabaseKey = 'public-anon-key'; // Replace with your Supabase anon/public key

const supabase = createClient(supabaseUrl, supabaseKey);

async function signInAndGetToken(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('Error signing in:', error.message);
    return null;
  }

  if (data.session) {
    console.log('Access Token (JWT):', data.session.access_token);
    return data.session.access_token;
  } else {
    console.error('No session returned');
    return null;
  }
}

// Replace with valid user credentials
const email = 'user@example.com';
const password = 'yourpassword';

signInAndGetToken(email, password).then(token => {
  if (token) {
    console.log('Use this token in Authorization header as: Bearer ' + token);
  }
});
