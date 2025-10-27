const { createServer } = require('https');
const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// Check for SSL certificates in project root (same pattern as builder)
const projectRoot = path.resolve(__dirname, '..');
const certPath = path.join(projectRoot, 'super.local.enso.bot+3.pem');
const keyPath = path.join(projectRoot, 'super.local.enso.bot+3-key.pem');

const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);

console.log('🔧 [Server Config] Certificate paths:', {
  certPath,
  keyPath,
  useHttps,
  certExists: fs.existsSync(certPath),
  keyExists: fs.existsSync(keyPath),
});

app.prepare().then(() => {
  const hostname = useHttps ? 'super.local.enso.bot' : 'localhost';
  const port = 3000;

  if (useHttps) {
    console.log('✅ [Server] Using HTTPS with certificates');
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };

    createServer(httpsOptions, async (req, res) => {
      try {
        const parsedUrl = parse(req.url, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('❌ [Server] Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('internal server error');
      }
    }).listen(port, hostname, (err) => {
      if (err) throw err;
      console.log('🚀 [Server] Ready on https://' + hostname + ':' + port);
      console.log('🔐 [Server] Using SSL certificates for local development');
      console.log('🌐 [Server] Cookie domain: .local.enso.bot');
    });
  } else {
    console.log('⚠️  [Server] Certificates not found, falling back to HTTP');
    console.log(
      '📝 [Server] To enable HTTPS, generate certificates in project root:',
    );
    console.log('   cd ' + projectRoot);
    console.log('   mkcert super.local.enso.bot localhost 127.0.0.1 ::1');
    console.log('');

    createHttpServer(async (req, res) => {
      try {
        const parsedUrl = parse(req.url, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('❌ [Server] Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('internal server error');
      }
    }).listen(port, hostname, (err) => {
      if (err) throw err;
      console.log('🚀 [Server] Ready on http://' + hostname + ':' + port);
      console.log(
        '⚠️  [Server] Running without HTTPS - Cognito cookies may not work',
      );
    });
  }
});
