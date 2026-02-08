export const config = {
  // Kortix Master port (main entry point)
  PORT: parseInt(process.env.KORTIX_MASTER_PORT || '8000'),

  // OpenCode server (proxied)
  OPENCODE_HOST: process.env.OPENCODE_HOST || 'localhost',
  OPENCODE_PORT: parseInt(process.env.OPENCODE_PORT || '4096'),
  OPENCODE_USERNAME: process.env.OPENCODE_SERVER_USERNAME || '',
  OPENCODE_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || '',

  // Kortix backend
  KORTIX_API_URL: process.env.KORTIX_API_URL || 'https://api.kortix.ai',
  KORTIX_LLM_URL: process.env.KORTIX_LLM_URL || 'https://api.kortix.ai/v1',
  KORTIX_TOKEN: process.env.KORTIX_TOKEN || '',

  // Secret storage
  SECRET_FILE_PATH: process.env.SECRET_FILE_PATH || '/app/secrets/.secrets.json',
  SALT_FILE_PATH: process.env.SALT_FILE_PATH || '/app/secrets/.salt',

  // Sandbox metadata
  SANDBOX_ID: process.env.SANDBOX_ID || '',
  PROJECT_ID: process.env.PROJECT_ID || '',
}
