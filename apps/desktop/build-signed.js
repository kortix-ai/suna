#!/usr/bin/env node

/**
 * Local build script with code signing
 * Loads credentials from .env file
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔨 Starting signed build...\n');

// Check if .env exists
if (!fs.existsSync('.env')) {
  console.log('⚠️  No .env file found');
  console.log('📝 Copy .env.example to .env and fill in your Apple credentials');
  console.log('   Or run: npm run build:mac:unsigned (for quick testing)\n');
  process.exit(1);
}

// Check required environment variables
const required = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
];

const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.log('❌ Missing required environment variables:');
  missing.forEach(key => console.log(`   - ${key}`));
  console.log('\n📝 Please add them to your .env file\n');
  process.exit(1);
}

// Check if certificate file exists
const certPath = process.env.CSC_LINK;
if (!certPath) {
  console.log('❌ CSC_LINK environment variable is not set');
  process.exit(1);
}

if (certPath.startsWith('./') || certPath.startsWith('../')) {
  const fullPath = path.resolve(__dirname, certPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`❌ Certificate file not found: ${fullPath}`);
    console.log('📝 Make sure CSC_LINK points to your .p12 file\n');
    process.exit(1);
  }
}

console.log('✅ Environment variables loaded');
console.log('✅ Certificate found');
console.log('\n🔨 Building with code signing and notarization...');
console.log('   This may take 5-10 minutes (notarization is slow)\n');

// Determine architecture
const arch = process.env.ARCH || 'universal';
const archFlag = arch === 'universal' ? '' : `--${arch}`;

try {
  // Resolve certificate path to absolute if relative
  const resolvedCertPath = certPath.startsWith('./') || certPath.startsWith('../')
    ? path.resolve(__dirname, certPath)
    : certPath;

  // Run electron-builder with signing
  execSync(`electron-builder --mac ${archFlag}`, {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Ensure certificate path is absolute
      CSC_LINK: resolvedCertPath
    }
  });

  console.log('\n✅ Build complete!');
  console.log('📦 Output: dist/\n');
  
  // List output files
  const distPath = path.join(__dirname, 'dist');
  if (fs.existsSync(distPath)) {
    const files = fs.readdirSync(distPath)
      .filter(f => f.endsWith('.dmg') || f.endsWith('.zip'))
      .map(f => `   ${f}`)
      .join('\n');
    
    if (files) {
      console.log('📦 Built files:');
      console.log(files);
      console.log('');
    }
  }

} catch (error) {
  console.error('\n❌ Build failed:', error.message);
  process.exit(1);
}
