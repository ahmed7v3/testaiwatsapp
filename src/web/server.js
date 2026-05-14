const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../logger');
const config = require('../config');
const database = require('../database');

class WebServer {
  constructor(botManager) {
    this.app = express();
    this.server = null;
    this.port = config.get('web.port') || 3000;
    this.host = config.get('web.host') || '0.0.0.0';
    this.botManager = botManager;
    this.tokens = new Set();
    this.running = false;
    this._messageLog = [];
    this._systemLog = [];
    this._setupMiddleware();
    this._setupRoutes();
  }

  _generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.add(token);
    return token;
  }

  _authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || !this.tokens.has(auth.slice(7))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  _setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  _setupRoutes() {
    this.app.post('/api/auth', (req, res) => {
      const { password } = req.body;
      const adminPw = config.get('security.adminPassword');
      if (password === adminPw) {
        const token = this._generateToken();
        res.json({ ok: true, token });
      } else {
        res.status(401).json({ error: 'Invalid password' });
      }
    });

    this.app.get('/api/status', this._authMiddleware.bind(this), (req, res) => {
      const instanceList = this.botManager.getInstanceList();
      const stats = database.collection('messages', {}).get();
      const active = this.botManager.getActiveInstance();
      res.json({
        ok: true,
        instances: instanceList,
        activeInstance: active ? { id: active.id, label: active.label, status: active.status } : null,
        stats: { sent: stats.sent || 0, received: stats.received || 0, total: (stats.sent || 0) + (stats.received || 0) },
        uptime: process.uptime(),
      });
    });

    this.app.get('/api/config', this._authMiddleware.bind(this), (req, res) => {
      res.json({ ok: true, config: config.data });
    });

    this.app.put('/api/config', this._authMiddleware.bind(this), (req, res) => {
      try {
        const updates = req.body;
        if (updates.ai) {
          if (updates.ai.provider !== undefined) config.set('ai.provider', updates.ai.provider);
          if (updates.ai.model !== undefined) config.set('ai.model', updates.ai.model);
          if (updates.ai.apiKey !== undefined) config.set('ai.apiKey', updates.ai.apiKey);
          if (updates.ai.baseUrl !== undefined) config.set('ai.baseUrl', updates.ai.baseUrl);
          if (updates.ai.systemPrompt !== undefined) config.set('ai.systemPrompt', updates.ai.systemPrompt);
          if (updates.ai.temperature !== undefined) config.set('ai.temperature', updates.ai.temperature);
          if (updates.ai.maxTokens !== undefined) config.set('ai.maxTokens', updates.ai.maxTokens);
        }
        if (updates.humanizer) {
          for (const [k, v] of Object.entries(updates.humanizer)) {
            config.set('humanizer.' + k, v);
          }
        }
        if (updates.security) {
          for (const [k, v] of Object.entries(updates.security)) {
            config.set('security.' + k, v);
          }
        }
        if (updates.bot) {
          for (const [k, v] of Object.entries(updates.bot)) {
            config.set('bot.' + k, v);
          }
        }
        if (updates.rules) {
          config.set('rules.enabled', updates.rules.enabled !== undefined ? updates.rules.enabled : config.get('rules.enabled'));
          if (updates.rules.items) config.set('rules.items', updates.rules.items);
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/log', this._authMiddleware.bind(this), (req, res) => {
      res.json({ ok: true, messages: this._messageLog.slice(-50), system: this._systemLog.slice(-20) });
    });

    this.app.get('/api/instances', this._authMiddleware.bind(this), (req, res) => {
      res.json({ ok: true, instances: this.botManager.getInstanceList() });
    });

    this.app.post('/api/instances/:id/restart', this._authMiddleware.bind(this), async (req, res) => {
      try {
        await this.botManager.stopInstance(req.params.id);
        await this.botManager.startInstance(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/switch/:id', this._authMiddleware.bind(this), (req, res) => {
      const ok = this.botManager.setActive(req.params.id);
      res.json({ ok });
    });

    this.app.post('/api/instances', this._authMiddleware.bind(this), async (req, res) => {
      try {
        const cfg = req.body;
        if (!cfg.id || !cfg.label) {
          return res.status(400).json({ error: 'id and label required' });
        }
        await this.botManager.addInstance(cfg);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete('/api/instances/:id', this._authMiddleware.bind(this), async (req, res) => {
      try {
        await this.botManager.removeInstance(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/upload', this._authMiddleware.bind(this), (req, res) => {
      try {
        const { fileName, data, caption } = req.body;
        if (!fileName || !data) {
          return res.status(400).json({ error: 'fileName and data (base64) required' });
        }
        const dir = path.resolve('data', 'media');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const buffer = Buffer.from(data, 'base64');
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, buffer);
        res.json({ ok: true, path: 'data/media/' + fileName, caption: caption || '' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
      } else {
        next();
      }
    });
  }

  pushMessage(direction, contact, text) {
    this._messageLog.push({ direction, contact, text, time: Date.now() });
    if (this._messageLog.length > 200) this._messageLog.shift();
  }

  pushLog(message, level) {
    this._systemLog.push({ message, level, time: Date.now() });
    if (this._systemLog.length > 100) this._systemLog.shift();
  }

  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        this.running = true;
        logger.info('Web server listening on http://' + this.host + ':' + this.port);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.running = false;
    }
  }

  getUrl() {
    return 'http://localhost:' + this.port;
  }
}

module.exports = WebServer;
