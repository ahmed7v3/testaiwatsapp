const logger = require('./logger');
const database = require('./database');

class BotManager {
  constructor() {
    this.instances = new Map();
    this.activeId = null;
    this._eventHandlers = {};
  }

  loadFromConfig() {
    const config = require('./config');
    const configs = config.getInstances();
    for (const cfg of configs) {
      if (cfg.enabled) {
        this.instances.set(cfg.id, {
          id: cfg.id,
          label: cfg.label,
          config: cfg,
          client: null,
          processor: null,
          status: 'stopped',
          qrCodeString: null,
        });
      }
    }
    if (this.instances.size > 0) {
      this.activeId = this.instances.keys().next().value;
    }
  }

  async startAll() {
    for (const id of this.instances.keys()) {
      await this.startInstance(id);
    }
  }

  async startInstance(id) {
    const entry = this.instances.get(id);
    if (!entry) return;

    const cfg = entry.config;
    const WhatsAppClient = require('./whatsapp/client');
    const MessageProcessor = require('./bot/processor');

    const client = new WhatsAppClient(cfg.sessionPath);
    const processor = new MessageProcessor({
      whatsappClient: client,
      instanceConfig: {
        id: cfg.id,
        systemPrompt: cfg.systemPrompt,
        name: cfg.name,
      },
    });

    entry.client = client;
    entry.processor = processor;

    client.on('qr', () => {
      entry.status = 'awaiting_qr';
      entry.qrCodeString = client.qrCodeString;
      this._emit('instance_qr', {
        instanceId: id,
        label: cfg.label,
        qrString: client.qrCodeString,
      });
    });

    client.on('disconnected', (reason) => {
      entry.status = 'disconnected';
      this._emit('instance_status', {
        instanceId: id,
        label: cfg.label,
        status: 'disconnected',
        reason,
      });
    });

    client.on('message', async (message) => {
      if (message.fromMe) return;
      const text = message.body?.trim() || '';
      const contact = message.from || 'unknown';
      if (text) {
        this._emit('instance_message', {
          instanceId: id,
          label: cfg.label,
          direction: 'in',
          contact,
          text,
          message,
        });
      }
      if (!contact.endsWith('@g.us') && text) {
        const chatStore = database.collection('activeChats', {});
        const chats = chatStore.get();
        chats[contact] = Date.now();
        chatStore.set(chats);
      }
      try {
        await processor.process(message);
      } catch (err) {
        logger.error(`[${cfg.label}] process error: ${err.message}`);
      }
    });

    client.on('message_create', async (message) => {
      if (message.fromMe && message.body) {
        const contact = message.to || 'unknown';
        if (!contact.endsWith('@g.us')) {
          this._emit('instance_message', {
            instanceId: id,
            label: cfg.label,
            direction: 'out',
            contact,
            text: message.body,
            message,
          });
        }
      }
    });

    entry.status = 'connecting';
    this._emit('instance_status', { instanceId: id, label: cfg.label, status: 'connecting' });

    await client.initialize();

    if (client.isReady()) {
      entry.status = 'connected';
      const me = client.getMe();
      if (me) {
        const info = me.pushname + ' (' + me.wid.user + ')';
        this._emit('instance_ready', { instanceId: id, label: cfg.label, info });
      }
    } else if (client.getStatus() === 'awaiting_qr') {
      entry.status = 'awaiting_qr';
    } else if (client.getStatus() === 'error') {
      entry.status = 'error';
    }

    this._emit('instance_status', { instanceId: id, label: cfg.label, status: entry.status });
  }

  async stopInstance(id) {
    const entry = this.instances.get(id);
    if (!entry || !entry.client) return;
    try {
      await entry.client.destroy();
    } catch (e) {}
    entry.status = 'stopped';
    entry.client = null;
    entry.processor = null;
    if (this.activeId === id) {
      const remaining = [...this.instances.keys()].filter((k) => k !== id);
      this.activeId = remaining.length > 0 ? remaining[0] : null;
    }
    this._emit('instance_status', { instanceId: id, label: entry.label, status: 'stopped' });
  }

  async stopAll() {
    for (const id of this.instances.keys()) {
      await this.stopInstance(id);
    }
  }

  async addInstance(cfg) {
    const config = require('./config');
    const instances = config.getInstances();
    instances.push(cfg);
    config.set('instances', instances);

    const entry = {
      id: cfg.id,
      label: cfg.label,
      config: cfg,
      client: null,
      processor: null,
      status: 'stopped',
      qrCodeString: null,
    };
    this.instances.set(cfg.id, entry);

    if (cfg.enabled) {
      await this.startInstance(cfg.id);
    }

    if (!this.activeId) {
      this.activeId = cfg.id;
    }

    this._emit('instance_status', { instanceId: cfg.id, label: cfg.label, status: entry.status });
    return cfg.id;
  }

  async removeInstance(id) {
    await this.stopInstance(id);
    this.instances.delete(id);

    const config = require('./config');
    const instances = config.getInstances().filter((i) => i.id !== id);
    config.set('instances', instances);

    this._emit('instance_status', { instanceId: id, label: id, status: 'removed' });
  }

  getActiveInstance() {
    return this.activeId ? this.instances.get(this.activeId) : null;
  }

  setActive(id) {
    if (this.instances.has(id)) {
      this.activeId = id;
      this._emit('active_changed', { instanceId: id, label: this.instances.get(id).label });
      return true;
    }
    return false;
  }

  switchNext() {
    const ids = [...this.instances.keys()];
    if (ids.length <= 1) return false;
    const idx = ids.indexOf(this.activeId);
    return this.setActive(ids[(idx + 1) % ids.length]);
  }

  switchPrev() {
    const ids = [...this.instances.keys()];
    if (ids.length <= 1) return false;
    const idx = ids.indexOf(this.activeId);
    return this.setActive(ids[(idx - 1 + ids.length) % ids.length]);
  }

  getInstanceList() {
    return [...this.instances.entries()].map(([id, inst]) => ({
      id,
      label: inst.label,
      status: inst.status,
      active: id === this.activeId,
    }));
  }

  getInstanceLabel(id) {
    const entry = this.instances.get(id);
    return entry ? entry.label : id;
  }

  on(event, handler) {
    if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
    this._eventHandlers[event].push(handler);
  }

  _emit(event, ...args) {
    const handlers = this._eventHandlers[event] || [];
    for (const h of handlers) {
      try {
        h(...args);
      } catch (err) {
        logger.error('BotManager handler error (' + event + '): ' + err.message);
      }
    }
  }
}

module.exports = BotManager;
