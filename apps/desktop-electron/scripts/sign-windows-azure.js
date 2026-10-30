// Signs one Windows file through Microsoft Artifact Signing. electron-builder calls it
// (`win.signtoolOptions.sign`) for every exe and the installer. Its built-in
// `azureSignOptions` uses the retired TrustedSigning module, whose NuGet v2 downloads
// fail; this uses ArtifactSigning, the module azure/trusted-signing-action uses for
// Kortix Capture. Auth: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
const { execFileSync } = require('node:child_process');

const MODULE_VERSION = '0.1.8';
let moduleReady = false;

const pwsh = (command) =>
  execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

module.exports = async function sign(configuration) {
  // electron-builder calls once per hash (sha1, sha256). One SHA-256 signature is enough.
  if (configuration.hash && configuration.hash !== 'sha256') return;
  const { AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE } = process.env;
  if (!AZURE_SIGNING_ENDPOINT || !AZURE_SIGNING_ACCOUNT || !AZURE_SIGNING_PROFILE) {
    throw new Error('sign-windows-azure: AZURE_SIGNING_ENDPOINT, _ACCOUNT and _PROFILE are required');
  }
  if (!moduleReady) {
    pwsh(
      `if (-not (Get-Module -ListAvailable ArtifactSigning | Where-Object Version -eq '${MODULE_VERSION}')) ` +
        `{ Install-Module -Name ArtifactSigning -RequiredVersion ${MODULE_VERSION} -Force -Repository PSGallery -Scope CurrentUser }`,
    );
    moduleReady = true;
  }
  pwsh(
    [
      'Invoke-ArtifactSigning',
      `-Endpoint ${quote(AZURE_SIGNING_ENDPOINT)}`,
      `-CodeSigningAccountName ${quote(AZURE_SIGNING_ACCOUNT)}`,
      `-CertificateProfileName ${quote(AZURE_SIGNING_PROFILE)}`,
      `-Files ${quote(configuration.path)}`,
      '-FileDigest SHA256',
      "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
      '-TimestampDigest SHA256',
    ].join(' '),
  );
};
