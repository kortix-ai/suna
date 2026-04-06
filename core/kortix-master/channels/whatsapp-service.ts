/**
 * WhatsApp Service for Kortix Channels — Baileys-based.
 *
 * Provides:
 *   - QR code login via Baileys (WhatsApp Web multi-device)
 *   - Real-time incoming message handling
 *   - Outgoing message sending
 *   - Session persistence to disk
 *
 * Architecture mirrors OpenClaw's WhatsApp extension.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { Boom } from '@hapi/boom';

import { OpenCodeClient, type FileOutput, type StreamEvent } from './opencode.js';
import { SessionManager } from './sessions.js';

// ── Constants ──────────────────────────────────────────────────────────

const AUTH_DIR = join(process.env.HOME || '/workspace', '.whatsapp-auth');
const QR_TTL_MS = 3 * 60_000; // QR expires after 3 minutes
const DEBOUNCE_MS = 2500;

// ── Types ──────────────────────────────────────────────────────────────

export interface WhatsAppServiceConfig {
  client: OpenCodeClient;
  sessions: SessionManager;
  getModel: () => { providerID: string; modelID: string } | undefined;
  setModel: (m: { providerID: string; modelID: string } | undefined) => void;
  getChannelInstructions: () => string | undefined;
}

interface QueuedMsg {
  text: string;
  replyContext?: string;
}

interface ThreadQueue {
  messages: QueuedMsg[];
  timer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  chatJid: string;
}

// ── WhatsApp Service ───────────────────────────────────────────────────

export class WhatsAppService {
  private sock: WASocket | null = null;
  private config: WhatsAppServiceConfig | null = null;
  private qrDataUrl: string | null = null;
  private qrTimestamp = 0;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private connectionMessage = '';
  private selfJid = '';
  private readonly threadQueues = new Map<string, ThreadQueue>();
  private readonly contextInjectedSessions = new Set<string>();
  private qrResolve: ((qr: string) => void) | null = null;
  private connectionResolve: ((result: { connected: boolean; message: string }) => void) | null = null;

  /**
   * Start QR code login flow. Returns base64 PNG data URL of the QR code.
   */
  async startQrLogin(force = false): Promise<{ qrDataUrl: string | null; message: string; alreadyConnected: boolean }> {
    // If already connected and not forcing
    if (this.sock && this.connectionStatus === 'connected' && !force) {
      return { qrDataUrl: null, message: 'Already connected to WhatsApp', alreadyConnected: true };
    }

    // Disconnect existing socket
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }

    // If force, clear auth state
    if (force && existsSync(AUTH_DIR)) {
      const { rm } = await import('node:fs/promises');
      await rm(AUTH_DIR, { recursive: true, force: true });
    }

    mkdirSync(AUTH_DIR, { recursive: true });

    this.connectionStatus = 'connecting';
    this.qrDataUrl = null;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      // Create a promise that resolves when QR is generated
      const qrPromise = new Promise<string>((resolve, reject) => {
        this.qrResolve = resolve;
        setTimeout(() => reject(new Error('QR generation timeout')), 30_000);
      });

      this.sock = makeWASocket({
        version,
        auth: state,
        browser: ['Kortix', 'Desktop', '1.0.0'],
        printQRInTerminal: false,
        logger: { level: 'silent', child: () => ({ level: 'silent', child: () => null } as any) } as any,
      });

      // Handle credential updates
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Generate QR code as PNG data URL
          QRCode.toDataURL(qr, { width: 256, margin: 2 })
            .then((dataUrl: string) => {
              this.qrDataUrl = dataUrl;
              this.qrTimestamp = Date.now();
              console.log('[whatsapp] QR code generated');
              if (this.qrResolve) {
                this.qrResolve(dataUrl);
                this.qrResolve = null;
              }
            })
            .catch(console.error);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log('[whatsapp] Connection closed:', statusCode, shouldReconnect ? '(will reconnect)' : '(logged out)');

          this.connectionStatus = 'disconnected';
          this.connectionMessage = shouldReconnect ? 'Disconnected, reconnecting...' : 'Logged out';

          if (this.connectionResolve) {
            this.connectionResolve({ connected: false, message: this.connectionMessage });
            this.connectionResolve = null;
          }

          if (shouldReconnect) {
            // Auto-reconnect after delay
            setTimeout(() => this.reconnect(), 3000);
          }
        }

        if (connection === 'open') {
          console.log('[whatsapp] Connected!');
          this.connectionStatus = 'connected';
          this.connectionMessage = 'Connected to WhatsApp';
          this.selfJid = this.sock?.user?.id || '';

          if (this.connectionResolve) {
            this.connectionResolve({ connected: true, message: 'Connected!' });
            this.connectionResolve = null;
          }
        }
      });

      // If auth state exists, might connect without QR
      if (state.creds?.me?.id) {
        // Already has credentials, might auto-connect
        try {
          const qr = await Promise.race([
            qrPromise,
            new Promise<string>((_, reject) => setTimeout(() => reject('no-qr-needed'), 5000)),
          ]);
          return { qrDataUrl: qr, message: 'Scan the QR code with WhatsApp on your phone', alreadyConnected: false };
        } catch {
          // No QR needed — already authenticated, will auto-connect
          return { qrDataUrl: null, message: 'Reconnecting with saved credentials...', alreadyConnected: false };
        }
      }

      const qr = await qrPromise;
      return { qrDataUrl: qr, message: 'Scan the QR code with WhatsApp on your phone', alreadyConnected: false };
    } catch (err) {
      this.connectionStatus = 'disconnected';
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[whatsapp] startQrLogin error:', msg);
      return { qrDataUrl: null, message: 'Failed to start login: ' + msg, alreadyConnected: false };
    }
  }

  /**
   * Wait for QR code scan and connection.
   */
  async waitForConnection(timeoutMs = 120_000): Promise<{ connected: boolean; message: string }> {
    if (this.connectionStatus === 'connected') {
      return { connected: true, message: 'Already connected' };
    }

    return new Promise((resolve) => {
      this.connectionResolve = resolve;
      setTimeout(() => {
        if (this.connectionResolve === resolve) {
          this.connectionResolve = null;
          resolve({ connected: this.connectionStatus === 'connected', message: this.connectionStatus === 'connected' ? 'Connected!' : 'Connection timeout' });
        }
      }, timeoutMs);
    });
  }

  /**
   * Get current status.
   */
  getStatus(): { status: string; connected: boolean; qrDataUrl: string | null; qrExpired: boolean; message: string; selfJid: string } {
    const qrExpired = this.qrDataUrl != null && (Date.now() - this.qrTimestamp > QR_TTL_MS);
    return {
      status: this.connectionStatus,
      connected: this.connectionStatus === 'connected',
      qrDataUrl: qrExpired ? null : this.qrDataUrl,
      qrExpired,
      message: this.connectionMessage,
      selfJid: this.selfJid,
    };
  }

  /**
   * Logout and clear credentials.
   */
  async logout(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
        this.sock.end(undefined);
        this.sock = null;
      }
      // Clear auth state
      if (existsSync(AUTH_DIR)) {
        const { rm } = await import('node:fs/promises');
        await rm(AUTH_DIR, { recursive: true, force: true });
      }
      this.connectionStatus = 'disconnected';
      this.qrDataUrl = null;
      this.selfJid = '';
      this.connectionMessage = 'Logged out';
      return { success: true, message: 'Logged out and credentials cleared' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Logout failed' };
    }
  }

  /**
   * Initialize the message bridge (call after connection is established).
   */
  initBridge(config: WhatsAppServiceConfig): void {
    this.config = config;
    if (!this.sock) return;

    // Register message handler
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const chatJid = msg.key.remoteJid;
        if (!chatJid) continue;

        // Skip status broadcasts
        if (chatJid === 'status@broadcast') continue;

        // Extract text
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        if (!text.trim()) continue;

        // Extract reply context
        let replyContext: string | undefined;
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted) {
          replyContext = quoted.conversation || quoted.extendedTextMessage?.text || '';
        }

        const pushName = msg.pushName || '';
        console.log('[whatsapp] Message from ' + pushName + ' (' + chatJid + '): ' + text.slice(0, 60));

        this.handleIncoming(chatJid, text.trim(), replyContext, msg.key.id || '');
      }
    });

    console.log('[whatsapp] Message bridge initialized');
  }

  /**
   * Send a text message.
   */
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || this.connectionStatus !== 'connected') {
      throw new Error('WhatsApp not connected');
    }

    // Send typing indicator
    await this.sock.presenceSubscribe(jid).catch(() => {});
    await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});

    // Convert markdown to WhatsApp formatting
    const formatted = markdownToWhatsApp(text);

    await this.sock.sendMessage(jid, { text: formatted });
    await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }

  // ── Private methods ──────────────────────────────────────────────────

  private async reconnect(): Promise<void> {
    if (this.connectionStatus === 'connected') return;
    if (!existsSync(join(AUTH_DIR, 'creds.json'))) return;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        browser: ['Kortix', 'Desktop', '1.0.0'],
        printQRInTerminal: false,
        logger: { level: 'silent', child: () => ({ level: 'silent', child: () => null } as any) } as any,
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.selfJid = this.sock?.user?.id || '';
          console.log('[whatsapp] Reconnected');
          if (this.config) this.initBridge(this.config);
        }
        if (connection === 'close') {
          const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
          if (code !== DisconnectReason.loggedOut) {
            setTimeout(() => this.reconnect(), 5000);
          }
        }
      });
    } catch (err) {
      console.error('[whatsapp] Reconnect failed:', err);
      setTimeout(() => this.reconnect(), 10000);
    }
  }

  private handleIncoming(chatJid: string, text: string, replyContext?: string, msgId?: string): void {
    if (!this.config) return;

    const threadId = 'whatsapp:' + chatJid;

    // Check for /commands
    if (text.startsWith('/')) {
      const handled = this.handleCommand(threadId, chatJid, text);
      if (handled) return;
    }

    this.enqueueMessage(threadId, chatJid, text, replyContext);
  }

  // ── Message queue & debounce ──────────────────────────���───────────

  private enqueueMessage(threadId: string, chatJid: string, text: string, replyContext?: string): void {
    let q = this.threadQueues.get(threadId);
    if (!q) {
      q = { messages: [], timer: null, processing: false, chatJid };
      this.threadQueues.set(threadId, q);
    }
    q.messages.push({ text, replyContext });
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => void this.flushQueue(threadId), DEBOUNCE_MS);
  }

  private async flushQueue(threadId: string): Promise<void> {
    const q = this.threadQueues.get(threadId);
    if (!q || q.messages.length === 0) return;
    if (q.processing) return;
    q.processing = true;
    q.timer = null;

    const batch = q.messages.splice(0);
    const combinedText = batch.map(m => m.text).join('\n');
    const replyContext = batch.find(m => m.replyContext)?.replyContext;

    try {
      await this.processMessage(threadId, q.chatJid, combinedText, replyContext);
    } catch (err) {
      console.error('[whatsapp] processMessage error:', err instanceof Error ? err.message : err);
    } finally {
      q.processing = false;
      if (q.messages.length > 0) {
        if (q.timer) clearTimeout(q.timer);
        q.timer = setTimeout(() => this.flushQueue(threadId), DEBOUNCE_MS);
      }
    }
  }

  private async processMessage(threadId: string, chatJid: string, userText: string, replyContext?: string): Promise<void> {
    if (!this.config) return;
    const { client, sessions, getModel, getChannelInstructions } = this.config;

    // Typing indicator
    if (this.sock) {
      await this.sock.presenceSubscribe(chatJid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', chatJid).catch(() => {});
    }

    let sessionId: string;
    try {
      sessionId = await sessions.resolve(threadId, client);
    } catch (err) {
      await this.sendText(chatJid, 'Could not connect to Kortix runtime: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const parts: string[] = [];
    let replyPrefix = '';
    if (replyContext) {
      const quoted = replyContext.length > 500 ? replyContext.slice(0, 500) + '...' : replyContext;
      replyPrefix = '[The user is replying to: "' + quoted + '"]\n\n';
    }

    const isFirstMessage = !this.contextInjectedSessions.has(sessionId);
    if (isFirstMessage) {
      this.contextInjectedSessions.add(sessionId);
      const instructions = getChannelInstructions();
      if (instructions) parts.push('[Channel instructions]\n' + instructions);
      parts.push('[Channel: whatsapp | chat: ' + chatJid + ' | IMPORTANT: Just respond with plain text. Your response is automatically delivered to the user. Do NOT use curl, /send, or any API to reply.]');
    }

    parts.push(replyPrefix + userText);
    const prompt = parts.join('\n\n');

    try {
      const eventStream = client.promptStreamEvents(sessionId, prompt, {
        agentName: sessions.getAgent(),
        model: getModel(),
      });

      let fullText = '';
      for await (const event of eventStream) {
        if (event.type === 'text' && event.data) fullText += event.data;
        if (event.type === 'permission' && event.permission) {
          await client.replyPermission(event.permission.id, true);
        }
        if (event.type === 'error') throw new Error(event.data || 'Agent error');
      }

      // Stop typing
      if (this.sock) await this.sock.sendPresenceUpdate('paused', chatJid).catch(() => {});

      if (fullText) {
        await this.sendText(chatJid, fullText);
      } else {
        await this.sendText(chatJid, 'No response from the agent.');
      }
    } catch (err) {
      if (this.sock) await this.sock.sendPresenceUpdate('paused', chatJid).catch(() => {});
      let errorMsg = err instanceof Error ? err.message : String(err);
      if (/API key not found/i.test(errorMsg)) errorMsg = 'Model/provider not configured correctly.';
      await this.sendText(chatJid, 'Something went wrong:\n\n' + errorMsg);
    }
  }

  // ── Command handling ────────────────────────────────────────────────

  private handleCommand(threadId: string, chatJid: string, text: string): boolean {
    const rawCmd = text.split(/\s+/)[0]!.toLowerCase();
    const args = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : '';
    const hasArgs = text.includes(' ');

    switch (rawCmd) {
      case '/start':
        void this.sendText(chatJid, '*Welcome to Kortix!*\n\nSend me a message and I\'ll respond using the Kortix agent. Use /help for commands.');
        return true;
      case '/help':
        void this.sendText(chatJid, '*Kortix Commands*\n\n/help - Show commands\n/models - List models\n/model <name> - Switch model\n/agents - List agents\n/agent <name> - Switch agent\n/status - Show status\n/reset - Reset session\n/new - New session');
        return true;
      case '/status':
        void this.handleStatusCmd(chatJid);
        return true;
      case '/reset':
      case '/new':
        this.config?.sessions.invalidate(threadId);
        void this.sendText(chatJid, 'Session reset. Send your first message.');
        return true;
      case '/models':
        void this.handleModelsCmd(chatJid);
        return true;
      case '/model':
        void this.handleModelCmd(chatJid, args, hasArgs);
        return true;
      case '/agents':
        void this.handleAgentsCmd(chatJid);
        return true;
      case '/agent':
        void this.handleAgentCmd(threadId, chatJid, args, hasArgs);
        return true;
      default:
        return false;
    }
  }

  private async handleStatusCmd(chatJid: string) {
    if (!this.config) return;
    const ready = await this.config.client.isReady();
    const cm = this.config.getModel();
    await this.sendText(chatJid,
      '*Status:* ' + (ready ? 'Connected' : 'Disconnected') +
      '\n*Model:* ' + (cm ? cm.modelID : 'default') +
      '\n*Agent:* ' + (this.config.sessions.getAgent() || 'default') +
      '\n*Sessions:* ' + this.config.sessions.size + ' active');
  }

  private async handleModelsCmd(chatJid: string) {
    if (!this.config) return;
    const providers = await this.config.client.listProviders();
    if (!providers.length) { await this.sendText(chatJid, 'No models configured.'); return; }
    const lines = providers.flatMap(p => p.models.map(m => '- ' + m.id + ' (' + p.name + ')'));
    const cm = this.config.getModel();
    await this.sendText(chatJid, '*Available Models:*\n' + lines.join('\n') + (cm ? '\n\n_Current: ' + cm.modelID + '_' : ''));
  }

  private async handleModelCmd(chatJid: string, args: string, hasArgs: boolean) {
    if (!this.config) return;
    if (!hasArgs) {
      const cm = this.config.getModel();
      await this.sendText(chatJid, '_Current model:_ ' + (cm ? cm.modelID : 'default') + '\n\nUsage: /model <name>');
      return;
    }
    const providers = await this.config.client.listProviders();
    const q = args.toLowerCase();
    for (const p of providers) for (const m of p.models) {
      if (m.id.toLowerCase().includes(q)) {
        this.config.setModel({ providerID: p.id, modelID: m.id });
        await this.sendText(chatJid, 'Model switched to ' + m.id + ' (' + p.name + ').');
        return;
      }
    }
    await this.sendText(chatJid, 'No model matching "' + args + '".');
  }

  private async handleAgentsCmd(chatJid: string) {
    if (!this.config) return;
    const agents = await this.config.client.listAgents();
    if (!agents.length) { await this.sendText(chatJid, 'No agents configured.'); return; }
    const lines = agents.map(a => '- *' + a.name + '*' + (a.description ? ' — ' + a.description : ''));
    await this.sendText(chatJid, '*Available Agents:*\n' + lines.join('\n'));
  }

  private async handleAgentCmd(threadId: string, chatJid: string, args: string, hasArgs: boolean) {
    if (!this.config) return;
    if (!hasArgs) {
      await this.sendText(chatJid, '_Current agent:_ *' + (this.config.sessions.getAgent() || 'default') + '*\n\nUsage: /agent <name>');
      return;
    }
    const agents = await this.config.client.listAgents();
    const matched = agents.find(a => a.name.toLowerCase() === args.toLowerCase());
    if (!matched) {
      await this.sendText(chatJid, 'Agent "' + args + '" not found.');
      return;
    }
    this.config.sessions.setAgent(matched.name);
    this.config.sessions.invalidate(threadId);
    await this.sendText(chatJid, 'Agent switched to *' + matched.name + '*. Session reset.');
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let _instance: WhatsAppService | null = null;
export function getWhatsAppService(): WhatsAppService {
  if (!_instance) _instance = new WhatsAppService();
  return _instance;
}

// ── Markdown conversion ────────────────────────────────────────────────

function markdownToWhatsApp(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.match(/^(\s*)(```)/)) {
      inCodeBlock = !inCodeBlock;
      result.push('```');
      continue;
    }
    if (inCodeBlock) { result.push(line); continue; }

    let c = line;
    c = c.replace(/`([^`]+)`/g, '```$1```');
    c = c.replace(/\*\*(.+?)\*\*/g, '*$1*');
    c = c.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '_$1_');
    c = c.replace(/~~(.+?)~~/g, '~$1~');
    c = c.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    c = c.replace(/^#{1,6}\s+(.+)$/, '*$1*');
    result.push(c);
  }
  if (inCodeBlock) result.push('```');
  return result.join('\n');
}
