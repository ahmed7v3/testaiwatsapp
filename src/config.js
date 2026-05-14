const path = require('path');
const fs = require('fs');
const logger = require('./logger');

require('dotenv').config();

const CONFIG_PATH = path.resolve('data', 'config.json');

const DEFAULTS = {
  whatsapp: {
    puppeteerHeadless: true,
    autoReconnect: true,
    reconnectInterval: 10000,
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'ollama',
    model: process.env.AI_MODEL || 'llama3.2',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || 'http://localhost:11434/v1',
    maxTokens: 512,
    temperature: 0.7,
    topP: 0.9,
    systemPrompt: `You are a helpful, natural-sounding WhatsApp assistant named Luna.
Keep responses conversational, concise (1-3 sentences when possible), and human-like.
Never mention that you are an AI, bot, or language model unless directly asked.
Use casual but polite language. Don't use markdown formatting.
Ask clarifying questions when needed. Be warm and friendly.`,
    contextLimit: 10,
    contextExpiryMinutes: 30,
  },
  humanizer: {
    enabled: true,
    typingMinPerChar: 60,
    typingMaxPerChar: 180,
    readReceiptDelayMin: 1000,
    readReceiptDelayMax: 4000,
    preResponseDelayMin: 500,
    preResponseDelayMax: 2000,
    activeHoursStart: 0,
    activeHoursEnd: 24,
    maxMessageLength: 1500,
    splitLongMessages: true,
    responseJitter: 0.3,
    gatheringDelayMs: 5000,
    minDelayBetweenReplies: 2000,
    reactionEnabled: true,
    reactionProbability: 0.15,
    reactionEmojis: ['👍', '❤️', '😂', '😮', '🔥', '💯', '👏', '✨', '🎉'],
  },
  security: {
    whitelistEnabled: false,
    whitelist: [],
    blacklist: [],
    rateLimitPerMin: 15,
    rateLimitPerHour: 120,
    maxMessageLength: 5000,
    maxAttachmentSize: 16777216,
    adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  },
  bot: {
    enabled: true,
    aiResponses: true,
    respondToGroups: false,
    respondToStatus: false,
    prefix: '!',
    statusMessage: 'Online',
  },
  dashboard: {
    refreshInterval: 500,
    maxLogLines: 100,
    maxMessageLines: 50,
  },
  web: {
    enabled: false,
    port: 3000,
    host: '0.0.0.0',
  },
  rules: {
    enabled: true,
    items: [
      {
        id: 'greeting',
        name: 'Greeting response',
        enabled: false,
        matchType: 'any',
        keywords: ['hi', 'hello', 'hey', 'good morning', 'good evening'],
        response: {
          type: 'text',
          content: 'Hello! How can I help you today?',
        },
      },
      {
        id: 'hours',
        name: 'Business hours',
        enabled: false,
        matchType: 'any',
        keywords: ['hours', 'open', 'when are you', 'working hours', 'business hours'],
        response: {
          type: 'text',
          content: 'We are open Monday-Friday, 9 AM to 6 PM EST.',
        },
      },
    ],
  },
  instances: [
    {
      id: 'default',
      label: 'Default',
      enabled: true,
      sessionPath: 'sessions',
      name: 'Luna',
    systemPrompt: `Your name is "Abd Ahmed" on WhatsApp.
You also have brothers "Obeid" on Telegram and Messenger, and they are still being built.

Your entire role and purpose is that whenever anyone messages you, you say: I am Ahmed's assistant/secretary working on WhatsApp. Ahmed is currently busy, so tell me what you need and I will help you.

You should be a bit funny and casual, simple and light in tone, without being aggressive or rude.

If someone insists on speaking directly to Ahmed, you can say something like: "Forget Ahmed, honestly he's kind of tired mentally, I'm better than him 😄 it's just life circumstances," and add a laughing emoji.

Your owner's full name is Ahmed Abu Al-Dahab, a programmer, web developer, AI tools developer, and e-commerce/websites developer.`,
    },
  ],
};

class Config {
  constructor() {
    this.data = null;
  }

  load() {
    try {
      let hadInstances = false;
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        hadInstances = !!(parsed.instances && Array.isArray(parsed.instances) && parsed.instances.length > 0);
        this.data = this._mergeDeep(DEFAULTS, parsed);
        logger.info('Configuration loaded from ' + CONFIG_PATH);
      } else {
        this.data = JSON.parse(JSON.stringify(DEFAULTS));
        this.save();
        logger.info('Default configuration created at ' + CONFIG_PATH);
      }
      this._applyEnvOverrides();
      this._migrateInstances(hadInstances);
    } catch (err) {
      logger.error('Failed to load config, using defaults: ' + err.message);
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  _applyEnvOverrides() {
    this.data.ai.provider = process.env.AI_PROVIDER || this.data.ai.provider;
    this.data.ai.model = process.env.AI_MODEL || this.data.ai.model;
    this.data.ai.apiKey = process.env.AI_API_KEY || this.data.ai.apiKey;
    this.data.ai.baseUrl = process.env.AI_BASE_URL || this.data.ai.baseUrl;
    this.data.security.adminPassword = process.env.ADMIN_PASSWORD || this.data.security.adminPassword;
  }

  get(pathStr) {
    const parts = pathStr.split('.');
    let current = this.data;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  set(pathStr, value) {
    const parts = pathStr.split('.');
    let current = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    this.save();
    return true;
  }

  toggle(pathStr) {
    const value = this.get(pathStr);
    if (typeof value === 'boolean') {
      this.set(pathStr, !value);
      return !value;
    }
    return null;
  }

  save() {
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      logger.error('Failed to save config: ' + err.message);
      return false;
    }
  }

  _migrateInstances(hadInstances) {
    const inst = this.data.instances;
    if (!inst || !Array.isArray(inst) || inst.length === 0) {
      this.data.instances = [
        {
          id: 'default',
          label: 'Default',
          enabled: true,
          sessionPath: 'sessions',
      name: 'Abd Ahmed',
          systemPrompt: this.data.ai.systemPrompt,
        },
      ];
      this.save();
    } else if (!hadInstances) {
      this.data.instances[0].systemPrompt = this.data.ai.systemPrompt;
      this.save();
    }
  }

  getInstances() {
    return this.data.instances || [];
  }

  getInstance(id) {
    return this.getInstances().find((i) => i.id === id) || null;
  }

  _mergeDeep(target, source) {
    const output = JSON.parse(JSON.stringify(target));
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!(key in output)) output[key] = {};
        output[key] = this._mergeDeep(output[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }
}

module.exports = new Config();
