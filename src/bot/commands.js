const config = require('../config');
const logger = require('../logger');
const database = require('../database');
const aiEngine = require('../ai/engine');

class CommandHandler {
  constructor() {
    this.whitelist = new Set();
    this._loadWhitelist();
  }

  _loadWhitelist() {
    const ids = config.get('security.whitelist') || [];
    this.whitelist = new Set(ids.map((id) => id.replace(/[^0-9]/g, '')));
  }

  isWhitelisted(contactId) {
    if (!config.get('security.whitelistEnabled')) return true;
    const clean = contactId.replace(/[^0-9]/g, '');
    return this.whitelist.has(clean);
  }

  isBlacklisted(contactId) {
    const blacklist = config.get('security.blacklist') || [];
    const clean = contactId.replace(/[^0-9]/g, '');
    return blacklist.some((id) => clean.includes(id.replace(/[^0-9]/g, '')));
  }

  checkRateLimit(contactId) {
    const store = database.collection('rateLimits', {});
    const limits = store.get();
    const now = Date.now();
    const cleanId = contactId.replace(/[^0-9]/g, '');

    if (!limits[cleanId]) {
      limits[cleanId] = { timestamps: [] };
    }

    const userLimits = limits[cleanId];
    const oneMinAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    userLimits.timestamps = userLimits.timestamps.filter((t) => t > oneHourAgo);
    userLimits.timestamps.push(now);

    const perMin = userLimits.timestamps.filter((t) => t > oneMinAgo).length;
    const perHour = userLimits.timestamps.length;

    const maxPerMin = config.get('security.rateLimitPerMin');
    const maxPerHour = config.get('security.rateLimitPerHour');

    store.set(limits);

    if (perMin > maxPerMin) return { limited: true, reason: 'Too many messages per minute.', retryAfter: 60 };
    if (perHour > maxPerHour) return { limited: true, reason: 'Daily message limit reached. Try again later.', retryAfter: 3600 };

    return { limited: false };
  }

  isCommand(text) {
    const prefix = config.get('bot.prefix');
    return typeof text === 'string' && text.startsWith(prefix);
  }

  async execute(text, contactId, isAdmin, msg) {
    const prefix = config.get('bot.prefix');
    const parts = text.slice(prefix.length).trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    const handlers = {
      help: () => this._cmdHelp(),
      status: () => this._cmdStatus(),
      ping: () => 'pong',
      about: () => this._cmdAbout(),
      prefix: () => `The current command prefix is: "${prefix}"`,
    };

    const adminHandlers = {
      enable: () => { config.set('bot.enabled', true); return 'Bot enabled'; },
      disable: () => { config.set('bot.enabled', false); return 'Bot disabled'; },
      'ai-on': () => { config.set('bot.aiResponses', true); return 'AI responses enabled'; },
      'ai-off': () => { config.set('bot.aiResponses', false); return 'AI responses disabled'; },
      humanize: () => { const v = config.toggle('humanizer.enabled'); return `Humanizer ${v ? 'enabled' : 'disabled'}`; },
      reset: () => { aiEngine.clearConversation(contactId); return 'Conversation reset'; },
      stats: () => this._cmdStats(),
    };

    if (handlers[command]) {
      return handlers[command]();
    }

    if (isAdmin && adminHandlers[command]) {
      return adminHandlers[command]();
    }

    if (isAdmin && command === 'auth' && args[0]) {
      config.set('security.adminPassword', args[0]);
      return 'Admin password updated';
    }

    if (isAdmin && command === 'whitelist' && args[0]) {
      if (args[0] === 'on') { config.set('security.whitelistEnabled', true); return 'Whitelist enabled'; }
      if (args[0] === 'off') { config.set('security.whitelistEnabled', false); return 'Whitelist disabled'; }
      if (args[0] === 'add' && args[1]) {
        const list = config.get('security.whitelist') || [];
        list.push(args[1]);
        config.set('security.whitelist', list);
        this._loadWhitelist();
        return `Added ${args[1]} to whitelist`;
      }
      if (args[0] === 'remove' && args[1]) {
        const list = (config.get('security.whitelist') || []).filter((id) => !id.includes(args[1]));
        config.set('security.whitelist', list);
        this._loadWhitelist();
        return `Removed ${args[1]} from whitelist`;
      }
      return 'Usage: !whitelist on|off|add <number>|remove <number>';
    }

    if (isAdmin && command === 'log') {
      const level = args[0];
      if (['error', 'warn', 'info', 'debug'].includes(level)) {
        logger.level = level;
        return `Log level set to ${level}`;
      }
      return `Current log level: ${logger.level}`;
    }

    return null;
  }

  _cmdHelp() {
    const prefix = config.get('bot.prefix');
    return [
      `*Available Commands*`,
      ``,
      `${prefix}help - Show this help`,
      `${prefix}status - Bot status`,
      `${prefix}ping - Check connection`,
      `${prefix}about - About this bot`,
      `${prefix}prefix - Show command prefix`,
      ``,
      `*Admin Commands*`,
      `${prefix}enable / ${prefix}disable - Toggle bot`,
      `${prefix}ai-on / ${prefix}ai-off - Toggle AI responses`,
      `${prefix}humanize - Toggle humanizer`,
      `${prefix}reset - Reset conversation context`,
      `${prefix}stats - Show usage statistics`,
      `${prefix}whitelist on|off - Toggle whitelist`,
      `${prefix}whitelist add|remove <num> - Manage whitelist`,
      `${prefix}auth <password> - Verify as admin`,
    ].join('\n');
  }

  _cmdStatus() {
    const enabled = config.get('bot.enabled');
    const aiEnabled = config.get('bot.aiResponses');
    const humanizer = config.get('humanizer.enabled');
    const whitelist = config.get('security.whitelistEnabled');
    const provider = config.get('ai.provider');
    const model = config.get('ai.model');
    return [
      `*Bot Status*`,
      `Bot: ${enabled ? '✅ Active' : '⛔ Disabled'}`,
      `AI: ${aiEnabled ? '✅ Active' : '⛔ Disabled'}`,
      `Humanizer: ${humanizer ? '✅ ON' : '⛔ OFF'}`,
      `Whitelist: ${whitelist ? '🔒 ON' : '🔓 OFF'}`,
      `Model: ${provider}/${model}`,
      `Active Hours: ${config.get('humanizer.activeHoursStart')}:00 - ${config.get('humanizer.activeHoursEnd')}:00`,
    ].join('\n');
  }

  _cmdAbout() {
    const pkg = require('../../package.json');
    return [
      `*WhatsApp AI Bot v${pkg.version}*`,
      ``,
      `A smart, human-like AI assistant for WhatsApp.`,
      `Built with whatsapp-web.js & Node.js.`,
      `Powered by ${config.get('ai.provider')} / ${config.get('ai.model')}.`,
    ].join('\n');
  }

  _cmdStats() {
    const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
    const msgs = msgStore.get();
    return [
      `*Bot Statistics*`,
      `Messages sent: ${msgs.sent || 0}`,
      `Messages received: ${msgs.received || 0}`,
      `Total: ${(msgs.sent || 0) + (msgs.received || 0)}`,
    ].join('\n');
  }

  authenticate(msg, password) {
    const adminPw = config.get('security.adminPassword');
    if (password === adminPw) {
      return true;
    }
    return false;
  }
}

module.exports = new CommandHandler();
