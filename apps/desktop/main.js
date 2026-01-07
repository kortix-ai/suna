const { app, BrowserWindow, clipboard, nativeImage, Menu } = require('electron');
const path = require('path');

// Custom protocol scheme for deep linking
const PROTOCOL_SCHEME = 'kortix';

// Get URL from environment variable or default to production
const APP_URL = process.env.APP_URL || 'https://kortix.com/';

// Simple dev check without ES module dependency
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Normalize URL - ensure localhost uses http, not https
function normalizeUrl(url) {
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return url.replace(/^https:\/\//, 'http://');
  }
  return url;
}

// Check if URL is localhost
function isLocalhost(url) {
  return url.includes('localhost') || url.includes('127.0.0.1');
}

const normalizedUrl = normalizeUrl(APP_URL);
const isLocal = isLocalhost(normalizedUrl);

// Set app name for macOS menu bar
if (process.platform === 'darwin') {
  app.setName('Kortix');
}

// Register as default protocol handler for kortix://
// This allows magic links to open in the desktop app
if (process.defaultApp) {
  // Development mode - register with path to electron executable
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

// Store pending deep link URL (received before window is ready)
let pendingDeepLinkUrl = null;

// Handle deep link URL
function handleDeepLink(url) {
  console.log('📱 Received deep link:', url);
  
  if (!url || !url.startsWith(`${PROTOCOL_SCHEME}://`)) {
    return;
  }
  
  // Convert kortix://auth/callback?code=xxx to https://kortix.com/auth/callback?code=xxx
  const deepLinkPath = url.replace(`${PROTOCOL_SCHEME}://`, '');
  const webUrl = normalizedUrl.endsWith('/') 
    ? normalizedUrl + deepLinkPath 
    : normalizedUrl + '/' + deepLinkPath;
  
  console.log('🔗 Converted to web URL:', webUrl);
  
  // Get the main window
  const mainWindow = BrowserWindow.getAllWindows()[0];
  
  if (mainWindow) {
    // Load the auth callback URL
    mainWindow.loadURL(webUrl);
    
    // Focus the window
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  } else {
    // Window not ready yet, store for later
    pendingDeepLinkUrl = webUrl;
  }
}

// macOS: Handle protocol when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows/Linux: Handle protocol from command line args
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is running, quit this one
  app.quit();
} else {
  // Handle second instance (Windows/Linux deep link)
  app.on('second-instance', (event, commandLine) => {
    // Find the deep link URL in command line args
    const deepLinkUrl = commandLine.find(arg => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    }
    
    // Focus the main window
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Ignore certificate errors for localhost (dev server) - must be called before app.whenReady()
if (isLocal) {
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.commandLine.appendSwitch('ignore-ssl-errors');
}

// Circular loading animation HTML
const loadingHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Kortix</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      background: #000000;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .loader-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }
    
    .circular-loader {
      width: 48px;
      height: 48px;
      border: 3px solid rgba(255, 255, 255, 0.1);
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    
    .loader-text {
      color: rgba(255, 255, 255, 0.5);
      font-size: 14px;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="loader-container">
    <div class="circular-loader"></div>
    <div class="loader-text">Loading...</div>
  </div>
</body>
</html>
`;

function createWindow() {
  // Use .icns for macOS (proper styling), PNG for other platforms
  const iconPath = process.platform === 'darwin' 
    ? path.resolve(__dirname, 'assets', 'icon.icns')
    : path.resolve(__dirname, 'assets', 'icon.png');
    
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    backgroundColor: '#000000',
    // Use default frame with native controls
    titleBarStyle: 'default',
    frame: true,
    transparent: false,
    show: false, // Don't show until ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: !isLocal,
    },
  });

  const { webContents } = mainWindow;

  // Show loading animation immediately
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Set custom user agent to identify Electron app
  webContents.setUserAgent(webContents.getUserAgent() + ' Electron/Kortix-Desktop');

  // Create menu with back/forward navigation
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'Kortix',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { 
          label: 'Back',
          accelerator: 'CmdOrCtrl+Left',
          click: () => {
            if (webContents.navigationHistory.canGoBack()) {
              webContents.navigationHistory.goBack();
            }
          }
        },
        { 
          label: 'Forward',
          accelerator: 'CmdOrCtrl+Right',
          click: () => {
            if (webContents.navigationHistory.canGoForward()) {
              webContents.navigationHistory.goForward();
            }
          }
        },
        { 
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => webContents.reload()
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Handle certificate errors for localhost
  if (isLocal) {
    webContents.on('certificate-error', (event, url, error, certificate, callback) => {
      if (isLocalhost(url)) {
        event.preventDefault();
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  // Always load auth page directly for desktop app
  const authUrl = normalizedUrl.endsWith('/') 
    ? normalizedUrl + 'auth' 
    : normalizedUrl + '/auth';
  
  // Load the actual URL after the loading screen is shown
  setTimeout(() => {
    mainWindow.loadURL(authUrl);
  }, 100);

  // Intercept navigation to prevent going to homepage and handle OAuth
  webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const url = new URL(navigationUrl);
      
      // Check if this is an OAuth URL
      const isOAuthUrl = navigationUrl.includes('accounts.google.com') ||
                         navigationUrl.includes('github.com/login/oauth') ||
                         navigationUrl.includes('api.github.com') ||
                         navigationUrl.includes('supabase.co/auth') ||
                         navigationUrl.includes('/auth/v1/authorize');
      
      if (isOAuthUrl) {
        console.log('🚫 Preventing OAuth navigation in main window');
        console.log('✅ Opening OAuth in popup instead:', navigationUrl);
        event.preventDefault();
        
        // Create OAuth popup window with loading animation
        const oauthWindow = new BrowserWindow({
          width: 600,
          height: 800,
          parent: mainWindow,
          modal: false,
          autoHideMenuBar: true,
          title: 'Sign In',
          backgroundColor: '#000000',
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });
        
        // Show loading animation first, then load OAuth URL
        oauthWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML)}`);
        oauthWindow.once('ready-to-show', () => {
          oauthWindow.show();
          oauthWindow.loadURL(navigationUrl);
        });
        
        // Handle OAuth callback - close popup and load callback in main window
        oauthWindow.webContents.on('will-navigate', (e, callbackUrl) => {
          if (callbackUrl.includes('/auth/callback') || callbackUrl.includes(normalizedUrl)) {
            console.log('✅ OAuth callback detected, closing popup');
            e.preventDefault();
            oauthWindow.close();
            mainWindow.loadURL(callbackUrl);
          }
        });
        
        oauthWindow.webContents.on('will-redirect', (e, callbackUrl) => {
          if (callbackUrl.includes('/auth/callback') || callbackUrl.includes(normalizedUrl)) {
            console.log('✅ OAuth redirect detected, closing popup');
            e.preventDefault();
            oauthWindow.close();
            mainWindow.loadURL(callbackUrl);
          }
        });
        
        return;
      }
      
      // Redirect homepage to auth
      if (url.pathname === '/' || url.pathname === '') {
        event.preventDefault();
        mainWindow.loadURL(authUrl);
        return;
      }
    } catch (e) {
      console.error('Navigation error:', e);
    }
  });

  // Inject homepage redirect protection on page load
  webContents.on('did-finish-load', () => {
    
    // Inject homepage redirect protection
    webContents.executeJavaScript(`
      (function() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        
        history.pushState = function() {
          const url = arguments[2];
          if (url === '/' || url === '') {
            window.location.href = '/auth';
            return;
          }
          return originalPushState.apply(history, arguments);
        };
        
        history.replaceState = function() {
          const url = arguments[2];
          if (url === '/' || url === '') {
            window.location.href = '/auth';
            return;
          }
          return originalReplaceState.apply(history, arguments);
        };
        
        if (window.location.pathname === '/' || window.location.pathname === '') {
          window.location.href = '/auth';
        }
        
        window.addEventListener('popstate', function() {
          if (window.location.pathname === '/' || window.location.pathname === '') {
            window.location.href = '/auth';
          }
        });
        
        // Intercept links with target="_blank" to ensure they open in popups
        document.addEventListener('click', function(e) {
          const link = e.target.closest('a[target="_blank"]');
          if (link && link.href) {
            const href = link.href;
            // OAuth URLs should open via window.open() to trigger popup handler
            const isOAuthUrl = href.includes('accounts.google.com') ||
                               href.includes('github.com/login/oauth') ||
                               href.includes('api.github.com') ||
                               href.includes('supabase.co/auth') ||
                               href.includes('oauth') ||
                               href.includes('authorize');
            
            if (isOAuthUrl) {
              e.preventDefault();
              window.open(href, '_blank', 'width=500,height=700');
            }
          }
        }, true);
      })();
    `).catch(() => {});
  });

  webContents.on('did-navigate', (event, url) => {
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname === '/' || urlObj.pathname === '') {
        mainWindow.loadURL(authUrl);
        return;
      }
    } catch (e) {}
  });

  webContents.on('did-navigate-in-page', (event, url) => {
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname === '/' || urlObj.pathname === '') {
        mainWindow.loadURL(authUrl);
        return;
      }
    } catch (e) {}
  });

  // Handle all window.open() calls - OAuth and external links
  webContents.setWindowOpenHandler(({ url }) => {
    console.log('🔗 Window open requested:', url);
    
    // OAuth URLs that should open in a popup window
    const isOAuthUrl = url.includes('accounts.google.com') ||
                       url.includes('github.com/login/oauth') ||
                       url.includes('api.github.com') ||
                       url.includes('supabase.co/auth') ||
                       url.includes('/auth/v1/authorize') ||
                       url.includes('oauth') ||
                       url.includes('authorize');
    
    if (isOAuthUrl) {
      console.log('✅ Opening OAuth in popup window');
      // Open OAuth in a popup window - Electron will create it
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 800,
          parent: mainWindow,
          modal: false,
          autoHideMenuBar: true,
          title: 'Sign In',
          backgroundColor: '#000000',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      };
    }
    
    console.log('🌐 Opening in system browser');
    // External links open in system browser
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  
  // Handle OAuth callback redirects from popup windows
  app.on('web-contents-created', (event, contents) => {
    // Only handle popup windows (not main window)
    if (contents !== webContents) {
      contents.on('will-navigate', (e, callbackUrl) => {
        if (callbackUrl.includes('/auth/callback') || callbackUrl.includes(normalizedUrl)) {
          e.preventDefault();
          // Close the popup
          const popupWindow = BrowserWindow.fromWebContents(contents);
          if (popupWindow) {
            popupWindow.close();
          }
          // Load callback in main window
          mainWindow.loadURL(callbackUrl);
        }
      });
      
      contents.on('will-redirect', (e, callbackUrl) => {
        if (callbackUrl.includes('/auth/callback') || callbackUrl.includes(normalizedUrl)) {
          e.preventDefault();
          // Close the popup
          const popupWindow = BrowserWindow.fromWebContents(contents);
          if (popupWindow) {
            popupWindow.close();
          }
          // Load callback in main window
          mainWindow.loadURL(callbackUrl);
        }
      });
    }
  });

  // Handle OAuth redirects back to the app in main window
  webContents.on('will-navigate', (event, url) => {
    // If navigating to our auth callback from OAuth, allow it
    if (url.includes('/auth/callback')) {
      // Re-inject nav bar after OAuth completes
      setTimeout(() => injectNavBar(), 500);
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    // Use .icns for macOS dock icon - ensures proper styling with rounded corners
    const iconPath = path.resolve(__dirname, 'assets', 'icon.icns');
    console.log('🎨 Setting dock icon from:', iconPath);
    try {
      const icon = nativeImage.createFromPath(iconPath);
      console.log('🎨 Icon loaded, isEmpty:', icon.isEmpty(), 'size:', icon.getSize());
      if (!icon.isEmpty()) {
        app.dock.setIcon(icon);
        console.log('✅ Dock icon set successfully');
      } else {
        console.error('❌ Icon is empty');
      }
    } catch (err) {
      console.error('❌ Error setting dock icon:', err);
    }
  }

  createWindow();

  // Handle pending deep link (received before window was ready)
  if (pendingDeepLinkUrl) {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.loadURL(pendingDeepLinkUrl);
    }
    pendingDeepLinkUrl = null;
  }

  // Check command line args for deep link on startup (Windows/Linux)
  if (process.platform !== 'darwin') {
    const deepLinkUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
