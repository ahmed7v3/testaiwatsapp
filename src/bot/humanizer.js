const config = require('../config');

class Humanizer {
  constructor() {
    this._offlineTimer = null;
  }

  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  random(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  isWithinActiveHours() {
    const hour = new Date().getHours();
    const start = config.get('humanizer.activeHoursStart');
    const end = config.get('humanizer.activeHoursEnd');
    return hour >= start && hour < end;
  }

  getActiveHoursMessage() {
    const start = config.get('humanizer.activeHoursStart');
    const end = config.get('humanizer.activeHoursEnd');
    return `Hey! I'm currently offline (active hours: ${start}:00-${end}:00). I'll get back to you when I'm back!`;
  }

  shouldProcessMessage() {
    if (!config.get('humanizer.enabled')) return true;
    return this.isWithinActiveHours();
  }

  showOnline(whatsapp) {
    try {
      if (whatsapp.client && typeof whatsapp.client.sendPresenceAvailable === 'function') {
        whatsapp.client.sendPresenceAvailable();
      }
    } catch (e) { /* non-critical */ }
    if (this._offlineTimer) {
      clearTimeout(this._offlineTimer);
      this._offlineTimer = null;
    }
  }

  goOfflineAfterDelay(whatsapp) {
    if (this._offlineTimer) clearTimeout(this._offlineTimer);
    this._offlineTimer = setTimeout(() => {
      try {
        if (whatsapp.client && typeof whatsapp.client.sendPresenceUnavailable === 'function') {
          whatsapp.client.sendPresenceUnavailable();
        }
      } catch (e) { /* */ }
      this._offlineTimer = null;
    }, 20000);
  }

  getGatheringDelay() {
    if (!config.get('humanizer.enabled')) return 0;
    return config.get('humanizer.gatheringDelayMs') || 5000;
  }

  getMinDelayBetweenReplies() {
    if (!config.get('humanizer.enabled')) return 0;
    return config.get('humanizer.minDelayBetweenReplies') || 2000;
  }

  calculateThinkingDelay(textLen) {
    if (!config.get('humanizer.enabled')) return 500;
    let delay = this.random(2000, 4000);
    if (textLen > 50) delay += this.random(1000, 3000);
    if (textLen > 200) delay += this.random(2000, 4000);
    const hour = new Date().getHours();
    if (hour >= 1 && hour <= 6) delay *= 1.5;
    if (hour >= 23 || hour <= 0) delay *= 1.3;
    return Math.min(delay, 10000);
  }

  calculateReadReceiptDelay() {
    if (!config.get('humanizer.enabled')) return 0;
    return this.random(
      config.get('humanizer.readReceiptDelayMin'),
      config.get('humanizer.readReceiptDelayMax')
    );
  }

  calculatePreResponseDelay() {
    if (!config.get('humanizer.enabled')) return 0;
    return this.random(
      config.get('humanizer.preResponseDelayMin'),
      config.get('humanizer.preResponseDelayMax')
    );
  }

  calculateTypingDelay(text) {
    if (!config.get('humanizer.enabled')) return 0;
    const charCount = text.length;
    const minPerChar = config.get('humanizer.typingMinPerChar');
    const maxPerChar = config.get('humanizer.typingMaxPerChar');
    const baseDelay = charCount * this.random(minPerChar, maxPerChar);
    const pauseJitter = Math.floor(Math.random() * 1500);
    return Math.min(Math.max(baseDelay + pauseJitter, 500), 10000);
  }

  async simulateTyping(whatsapp, chatId, responseText) {
    if (!config.get('humanizer.enabled')) return;
    const typingDelay = this.calculateTypingDelay(responseText);
    if (typingDelay <= 0) return;

    try {
      await whatsapp.startTyping(chatId);
      if (typingDelay > 3000) {
        await this.delay(typingDelay * 0.6);
        await whatsapp.stopTyping(chatId);
        await this.delay(this.random(400, 1000));
        await whatsapp.startTyping(chatId);
        await this.delay(typingDelay * 0.4);
      } else {
        await this.delay(typingDelay);
      }
      await whatsapp.stopTyping(chatId);
      await this.delay(this.random(100, 400));
    } catch (e) { /* non-critical */ }
  }

  shouldReact() {
    if (!config.get('humanizer.enabled')) return false;
    if (!config.get('humanizer.reactionEnabled')) return false;
    return Math.random() < (config.get('humanizer.reactionProbability') || 0);
  }

  getRandomReaction() {
    const emojis = config.get('humanizer.reactionEmojis') || ['👍'];
    return emojis[Math.floor(Math.random() * emojis.length)];
  }

  getReactionDelay() {
    if (!config.get('humanizer.enabled')) return 0;
    return this.random(500, 2500);
  }

  splitMessage(text) {
    if (!config.get('humanizer.splitLongMessages')) return [text];
    const maxLen = config.get('humanizer.maxMessageLength');
    if (text.length <= maxLen) return [text];

    const parts = [];
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    let current = '';

    for (const sentence of sentences) {
      if ((current + sentence).length > maxLen && current.length > 0) {
        parts.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts.length ? parts : [text.substring(0, maxLen)];
  }

  shouldAddCasualPrefix() {
    if (!config.get('humanizer.enabled')) return false;
    return Math.random() < 0.15;
  }

  getCasualPrefix() {
    const prefixes = [
      'Hey! ', 'Hey there! ', 'Hi! ', 'So ', 'Well, ', 'Hmm, ',
      'Sure! ', 'Okay, ', 'Alright, ', 'Got it! ', '',
    ];
    return prefixes[Math.floor(Math.random() * prefixes.length)];
  }

  getRandomGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }
}

module.exports = new Humanizer();
