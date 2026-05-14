const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const logger = require('../logger');
const config = require('../config');

function findChrome() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

class WhatsAppClient {
  constructor(sessionPath) {
    this.client = null;
    this.qrCodeData = null;
    this.qrCodeString = null;
    this.connectionStatus = 'disconnected';
    this.me = null;
    this._ready = false;
    this._eventHandlers = {};
    this.sessionPath = sessionPath || 'sessions';
  }

  async initialize() {
    return new Promise((resolve) => {
      const sessionPath = path.resolve(this.sessionPath);

      const chromePath = findChrome();
      const puppeteerOpts = {
        headless: config.get('whatsapp.puppeteerHeadless'),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      };
      if (chromePath) {
        puppeteerOpts.executablePath = chromePath;
        logger.info('Using Chrome: ' + chromePath);
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: sessionPath,
        }),
        puppeteer: puppeteerOpts,
        qrTimeout: 120000,
        restartOnAuthFail: true,
      });

      this.client.on('qr', async (qr) => {
        this.qrCodeData = qr;
        this.connectionStatus = 'awaiting_qr';

        try {
          this.qrCodeString = await QRCode.toString(qr, {
            type: 'terminal',
            small: true,
            width: 2,
            margin: 1,
          });
        } catch (err) {
          this.qrCodeString = 'QR: ' + qr.substring(0, 50) + '...';
        }

        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            type: 'png',
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
          const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WhatsApp QR</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;flex-direction:column;}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,0.12);text-align:center;}
img{display:block;width:340px;height:340px;image-rendering:pixelated;}
h1{font-size:20px;color:#075e54;margin-top:20px;}
p{color:#555;margin-top:8px;font-size:15px;}
.steps{text-align:left;margin-top:16px;padding:12px 20px;background:#f0fdf4;border-radius:8px;font-size:14px;}
.steps li{margin:6px 0;color:#333;}
.steps b{color:#075e54;}
.footer{margin-top:20px;font-size:12px;color:#999;}
</style></head>
<body>
<div class="card">
<img src="${qrDataUrl}" alt="QR Code"/>
<h1>Link WhatsApp</h1>
<p>Scan this code with your phone</p>
<div class="steps">
<ol>
<li>Open <b>WhatsApp</b> on your phone</li>
<li>Tap <b>⋮</b> (Android) or <b>Settings</b> (iPhone)</li>
<li>Go to <b>Linked Devices</b> → <b>Link a Device</b></li>
<li>Point your phone at this screen</li>
</ol>
</div>
<div class="footer">This page auto-refreshes every 25s. Close after scanning.</div>
</div>
<script>setTimeout(function(){location.reload();},25000);</script>
</body>
</html>`;
          const htmlPath = path.resolve('data', 'qr-code.html');
          fs.writeFileSync(htmlPath, html);
          exec('start "" "' + htmlPath + '"', (err) => {
            if (err) logger.warn('Could not open QR page: ' + err.message);
          });
          logger.info('QR page opened in browser (data/qr-code.html)');
        } catch (err) {
          logger.warn('Failed to open QR in browser: ' + err.message);
        }

        logger.info('QR code generated - scan the opened page');
        this._emit('qr', qr);
      });

      this.client.on('authenticated', () => {
        this.connectionStatus = 'authenticated';
        logger.info('WhatsApp session authenticated');
      });

      this.client.on('auth_failure', (msg) => {
        this.connectionStatus = 'auth_failed';
        logger.error('WhatsApp authentication failed: ' + msg);
      });

      this.client.on('ready', () => {
        this._ready = true;
        this.connectionStatus = 'connected';
        this.me = this.client.info;
        logger.info('WhatsApp client ready as ' + (this.me.pushname || this.me.wid.user));
        resolve();
      });

      this.client.on('disconnected', (reason) => {
        this._ready = false;
        this.connectionStatus = 'disconnected';
        logger.warn('WhatsApp disconnected: ' + reason);
        this._emit('disconnected', reason);

        if (config.get('whatsapp.autoReconnect')) {
          const interval = config.get('whatsapp.reconnectInterval');
          logger.info('Reconnecting in ' + (interval / 1000) + 's...');
          setTimeout(() => {
            this.initialize().catch((err) => {
              logger.error('Reconnection failed: ' + err.message);
            });
          }, interval);
        }
      });

      this.client.on('message_create', (message) => {
        this._emit('message_create', message);
      });

      this.client.on('message', (message) => {
        this._emit('message', message);
      });

      this.client.initialize().catch((err) => {
        logger.error('WhatsApp initialization failed: ' + err.message);
        this.connectionStatus = 'error';
        resolve();
      });
    });
  }

  async getChatById(chatId) {
    return this.client.getChatById(chatId);
  }

  async sendMessage(chatId, content) {
    return this.client.sendMessage(chatId, content);
  }

  async sendMedia(chatId, media, caption) {
    const options = caption ? { caption } : {};
    return this.client.sendMessage(chatId, media, options);
  }

  async markAsRead(chatId) {
    try {
      const chat = await this.client.getChatById(chatId);
      await chat.sendSeen();
    } catch (err) {
      // silently fail - non-critical
    }
  }

  async startTyping(chatId) {
    try {
      const chat = await this.client.getChatById(chatId);
      await chat.sendStateTyping();
    } catch (err) {
      // non-critical
    }
  }

  async stopTyping(chatId) {
    try {
      const chat = await this.client.getChatById(chatId);
      await chat.clearState();
    } catch (err) {
      // non-critical
    }
  }

  async simulateTyping(chatId, durationMs) {
    await this.startTyping(chatId);
    return new Promise((resolve) => {
      setTimeout(async () => {
        await this.stopTyping(chatId);
        resolve();
      }, durationMs);
    });
  }

  on(event, handler) {
    if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
    this._eventHandlers[event].push(handler);
  }

  _emit(event, ...args) {
    const handlers = this._eventHandlers[event] || [];
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        logger.error('Event handler error (' + event + '): ' + err.message);
      }
    }
  }

  isReady() {
    return this._ready;
  }

  getStatus() {
    return this.connectionStatus;
  }

  getMe() {
    return this.me;
  }

  async destroy() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        // ignore
      }
    }
    this._ready = false;
    this.connectionStatus = 'disconnected';
  }
}

module.exports = WhatsAppClient;
