const config = require('../config');
const logger = require('../logger');
const database = require('../database');
const aiEngine = require('../ai/engine');
const humanizer = require('./humanizer');
const commands = require('./commands');
const rules = require('./rules');
const dashboard = require('../dashboard/ui');

class MessageProcessor {
  constructor({ whatsappClient, instanceConfig } = {}) {
    this.processedIds = new Set();
    this.gatheringTimers = new Map();
    this.processingLocks = new Map();
    this.lastReplyTime = new Map();
    this.whatsapp = whatsappClient;
    this.instanceConfig = instanceConfig || {};
  }

  async process(message) {
    try {
      if (!message) return;
      if (message.fromMe) return;

      let msgId;
      if (message.id) {
        msgId = message.id._serialized || String(message.id);
        if (this.processedIds.has(msgId)) return;
        this.processedIds.add(msgId);
        if (this.processedIds.size > 2000) {
          const arr = [...this.processedIds];
          this.processedIds = new Set(arr.slice(-1000));
        }
      }

      const chatId = message.from || message.to;
      const isGroup = message.from?.endsWith('@g.us');
      const contactId = isGroup ? (message.author || message.from) : (message.from || message.to);
      let text = message.body?.trim();

      if (isGroup && !config.get('bot.respondToGroups')) return;

      if (!text && message.hasMedia) {
        text = await this._handleVoiceMessage(message);
      }

      if (!text) return;

      const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
      msgStore.update((d) => { d.total = (d.total || 0) + 1; d.received = (d.received || 0) + 1; return d; });

      if (commands.isBlacklisted(contactId)) return;
      if (!commands.isWhitelisted(contactId)) return;
      if (commands.checkRateLimit(contactId).limited) return;

      message.body = text;

      if (commands.isCommand(text)) {
        await this._handleCommand(message, chatId, contactId, text);
        return;
      }

      const ruleMatch = rules.check(text);
      if (ruleMatch) {
        await this._handleRuleResponse(chatId, message, ruleMatch, text);
        return;
      }

      if (!config.get('bot.enabled') || !config.get('bot.aiResponses')) return;

      this._gatherOrProcess(chatId, message);
    } catch (err) {
      logger.error('process error: ' + err.message);
    }
  }

  _gatherOrProcess(chatId, message) {
    if (this.processingLocks.get(chatId)) {
      if (this.gatheringTimers.has(chatId)) {
        clearTimeout(this.gatheringTimers.get(chatId));
      }
      const timer = setTimeout(() => {
        this.gatheringTimers.delete(chatId);
        this._processAfterGathering(chatId, message);
      }, humanizer.getGatheringDelay());
      this.gatheringTimers.set(chatId, timer);
      return;
    }

    if (this.gatheringTimers.has(chatId)) {
      clearTimeout(this.gatheringTimers.get(chatId));
    }

    const delay = humanizer.getGatheringDelay();
    if (delay <= 0) {
      this._processAfterGathering(chatId, message);
      return;
    }

    const timer = setTimeout(() => {
      this.gatheringTimers.delete(chatId);
      this._processAfterGathering(chatId, message);
    }, delay);
    this.gatheringTimers.set(chatId, timer);
  }

  async _processAfterGathering(chatId, message) {
    if (this.processingLocks.get(chatId)) return;
    this.processingLocks.set(chatId, true);

    try {
      if (this.gatheringTimers.has(chatId)) {
        clearTimeout(this.gatheringTimers.get(chatId));
        this.gatheringTimers.delete(chatId);
      }

      humanizer.showOnline(this.whatsapp);
      const contactId = message.from || message.to;
      const text = message.body?.trim() || '';

      const msgLen = text.length;
      const baseDelay = humanizer.calculateThinkingDelay(msgLen);
      await humanizer.delay(baseDelay);

      const readDelay = humanizer.calculateReadReceiptDelay();
      await humanizer.delay(readDelay);
      await this.whatsapp.markAsRead(chatId);

      if (humanizer.shouldReact() && typeof message.react === 'function') {
        await humanizer.delay(humanizer.getReactionDelay());
        try { await message.react(humanizer.getRandomReaction()); } catch (e) { /* non-critical */ }
      }

      const preDelay = humanizer.calculatePreResponseDelay();
      await humanizer.delay(preDelay);

      const minGap = humanizer.getMinDelayBetweenReplies();
      const elapsed = Date.now() - (this.lastReplyTime.get(chatId) || 0);
      if (elapsed < minGap) await humanizer.delay(minGap - elapsed);

      const systemPrompt = this.instanceConfig.systemPrompt;
      const aiResponse = await aiEngine.generateResponse(contactId, text, {}, systemPrompt, this.instanceConfig.id);

      if (!aiResponse) {
        logger.warn('AI empty for ' + contactId);
        return;
      }

      if (/error|invalid|model |API |blocked|network|quota/i.test(aiResponse)) {
        try { dashboard.addLog('⚠ AI: ' + aiResponse.substring(0, 120), 'error'); } catch (e) {}
      }

      const parts = humanizer.splitMessage(aiResponse);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        await humanizer.simulateTyping(this.whatsapp, chatId, part);

        let finalMsg = part;
        if (i === 0 && humanizer.shouldAddCasualPrefix()) {
          finalMsg = humanizer.getCasualPrefix() + part;
        }

        await this.whatsapp.sendMessage(chatId, finalMsg);

        if (i < parts.length - 1) {
          await humanizer.delay(humanizer.random(1200, 3500));
        }
      }

      this.lastReplyTime.set(chatId, Date.now());

      const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
      msgStore.update((d) => { d.sent = (d.sent || 0) + parts.length; return d; });
    } catch (err) {
      logger.error('AI reply error: ' + err.message);
    } finally {
      this.processingLocks.set(chatId, false);
      humanizer.goOfflineAfterDelay(this.whatsapp);
    }
  }

  async _handleCommand(message, chatId, contactId, text) {
    let isAdmin = false;
    let reply = null;

    if (text.toLowerCase().startsWith(config.get('bot.prefix') + 'auth ')) {
      const pw = text.slice(config.get('bot.prefix').length + 5).trim();
      isAdmin = commands.authenticate(message, pw);
      if (isAdmin) {
        reply = '✅ Authenticated as admin';
        const cache = database.collection('authCache', {}).get();
        cache[contactId] = true;
        database.collection('authCache', {}).set(cache);
      } else {
        reply = '❌ Invalid password';
      }
    } else {
      const prevAuth = database.collection('authCache', {}).get();
      isAdmin = prevAuth[contactId] === true;
    }

    const cmdReply = await commands.execute(text, contactId, isAdmin, message);
    if (cmdReply) reply = cmdReply;
    if (!reply && !isAdmin) reply = 'Use ' + config.get('bot.prefix') + 'auth <password> to authenticate';

    if (reply) {
      if (message.from?.endsWith('@g.us')) return;
      await this._sendReply(chatId, reply, message);
    }
  }

  async _handleVoiceMessage(message) {
    try {
      if (!message.hasMedia) return null;
      const media = await message.downloadMedia();
      if (!media || !media.data) return null;
      if (!media.mimetype || !media.mimetype.startsWith('audio/')) return null;

      dashboard.addLog('Voice message received, transcribing...', 'info');
      const transcribed = await aiEngine.transcribeAudio(media.data, media.mimetype);
      if (transcribed) {
        dashboard.addLog('Transcribed: "' + transcribed.substring(0, 80) + '"', 'success');
        return transcribed;
      }
      dashboard.addLog('Voice transcription failed', 'error');
      return null;
    } catch (err) {
      logger.error('Voice handling error: ' + err.message);
      return null;
    }
  }

  async _handleRuleResponse(chatId, message, ruleMatch, text) {
    if (this.processingLocks.get(chatId)) return;
    this.processingLocks.set(chatId, true);

    try {
      humanizer.showOnline(this.whatsapp);

      const readDelay = humanizer.calculateReadReceiptDelay();
      await humanizer.delay(readDelay);
      await this.whatsapp.markAsRead(chatId);

      const thinkDelay = humanizer.calculateThinkingDelay(text.length);
      await humanizer.delay(thinkDelay);

      if (ruleMatch.type === 'text') {
        const parts = humanizer.splitMessage(ruleMatch.content);
        for (let i = 0; i < parts.length; i++) {
          await humanizer.simulateTyping(this.whatsapp, chatId, parts[i]);
          await this.whatsapp.sendMessage(chatId, parts[i]);
          if (i < parts.length - 1) {
            await humanizer.delay(humanizer.random(800, 2500));
          }
        }
      } else if (ruleMatch.type === 'image' || ruleMatch.type === 'file') {
        const media = rules.resolveMedia(ruleMatch);
        if (media) {
          await humanizer.delay(humanizer.random(1000, 3000));
          await this.whatsapp.sendMedia(chatId, media, ruleMatch.caption || '');
        } else {
          const fallback = ruleMatch.fallback || 'Sorry, I could not load the requested file.';
          await this.whatsapp.sendMessage(chatId, fallback);
        }
      }

      this.lastReplyTime.set(chatId, Date.now());
      const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
      msgStore.update((d) => { d.sent = (d.sent || 0) + 1; return d; });
    } catch (err) {
      logger.error('rule response error: ' + err.message);
    } finally {
      this.processingLocks.set(chatId, false);
      humanizer.goOfflineAfterDelay(this.whatsapp);
    }
  }

  async _sendReply(chatId, predefinedReply, incomingMsg) {
    if (this.processingLocks.get(chatId)) return;
    this.processingLocks.set(chatId, true);

    try {
      humanizer.showOnline(this.whatsapp);

      if (incomingMsg) {
        const readDelay = humanizer.calculateReadReceiptDelay();
        await humanizer.delay(readDelay);
        await this.whatsapp.markAsRead(chatId);
      }

      const parts = humanizer.splitMessage(predefinedReply);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        await humanizer.simulateTyping(this.whatsapp, chatId, part);
        await this.whatsapp.sendMessage(chatId, part);
        if (i < parts.length - 1) {
          await humanizer.delay(humanizer.random(800, 2500));
        }
      }

      this.lastReplyTime.set(chatId, Date.now());
      const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
      msgStore.update((d) => { d.sent = (d.sent || 0) + parts.length; return d; });
    } catch (err) {
      logger.error('send reply error: ' + err.message);
    } finally {
      this.processingLocks.set(chatId, false);
      humanizer.goOfflineAfterDelay(this.whatsapp);
    }
  }
}

module.exports = MessageProcessor;
