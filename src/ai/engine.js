const OpenAI = require('openai');
const config = require('../config');
const logger = require('../logger');

let googleGenAI = null;
try {
  googleGenAI = require('@google/generative-ai');
} catch (e) {
  // Optional dependency
}

const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  ollama: { baseUrl: 'http://localhost:11434/v1', needsKey: false },
  custom: { baseUrl: '', needsKey: false },
  gemini: { baseUrl: '', needsKey: true, native: true },
};

class AIEngine {
  constructor() {
    this.client = null;
    this.geminiClient = null;
    this.conversations = new Map();
    this._contextTimer = null;
    this._startContextCleanup();
  }

  initialize() {
    const provider = config.get('ai.provider');
    const providerConfig = PROVIDERS[provider];

    if (!providerConfig) {
      logger.error('Unknown AI provider: ' + provider);
      return false;
    }

    logger.info('Initializing AI engine: provider=' + provider + ', model=' + config.get('ai.model'));

    if (provider === 'gemini') {
      if (!googleGenAI) {
        logger.error('@google/generative-ai package not available');
        return false;
      }
      const apiKey = config.get('ai.apiKey');
      if (!apiKey) {
        logger.error('Gemini requires an API key. Press K to set one.');
        return false;
      }
      this.geminiClient = new googleGenAI.GoogleGenerativeAI(apiKey);
      this.client = null;
    } else {
      const baseUrl = config.get('ai.baseUrl') || providerConfig.baseUrl;
      const apiKey = config.get('ai.apiKey') || (providerConfig.needsKey ? null : 'not-needed');

      if (providerConfig.needsKey && !config.get('ai.apiKey')) {
        logger.error(provider + ' requires an API key');
        return false;
      }

      this.client = new OpenAI({
        baseURL: baseUrl,
        apiKey: apiKey,
      });
      this.geminiClient = null;
    }

    return true;
  }

  async generateResponse(contactId, message, context = {}, systemPromptOverride, instanceId) {
    const provider = config.get('ai.provider');
    const enabled = config.get('bot.aiResponses');

    if (!enabled || !config.get('bot.enabled')) {
      return null;
    }

    if (provider === 'gemini') {
      return this._generateGemini(contactId, message, context, systemPromptOverride, instanceId);
    }
    return this._generateOpenAI(contactId, message, context, systemPromptOverride, instanceId);
  }

  async _generateOpenAI(contactId, message, context, systemPromptOverride, instanceId) {
    if (!this.client) {
      logger.error('OpenAI client not initialized');
      return 'Sorry, my AI engine is not configured properly.';
    }

    const model = config.get('ai.model');
    const systemPrompt = systemPromptOverride || config.get('ai.systemPrompt');
    const maxTokens = config.get('ai.maxTokens');
    const temperature = config.get('ai.temperature');
    const contextLimit = config.get('ai.contextLimit');

    const convKey = instanceId ? instanceId + ':' + contactId : contactId;
    const conv = this._getConversation(convKey);
    conv.push({ role: 'user', content: message });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conv.slice(-contextLimit * 2),
    ];

    try {
      const response = await this.client.chat.completions.create({
        model: model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: temperature,
      });

      const reply = response.choices[0]?.message?.content || '';
      if (reply) {
        conv.push({ role: 'assistant', content: reply });
        this._updateContextExpiry(convKey);
      }
      return reply || '...';
    } catch (err) {
      logger.error('AI generation failed: ' + err.message);

      if (err.message && err.message.includes('Connection refused')) {
        return 'I need a moment - my AI brain is starting up. Try again in a few seconds!';
      }
      return 'Hmm, I had trouble processing that. Could you rephrase?';
    }
  }

  async _generateGemini(contactId, message, context, systemPromptOverride, instanceId) {
    if (!this.geminiClient) {
      return 'AI engine not initialized. Press K to set your API key.';
    }

    const model = config.get('ai.model') || 'gemini-2.5-pro-preview-03-25';
    const systemPrompt = systemPromptOverride || config.get('ai.systemPrompt');
    const maxTokens = config.get('ai.maxTokens');
    const temperature = config.get('ai.temperature');
    const contextLimit = config.get('ai.contextLimit');

    const convKey = instanceId ? instanceId + ':' + contactId : contactId;
    const conv = this._getConversation(convKey);
    conv.push({ role: 'user', content: message });

    try {
      const historyBlock = conv.slice(-contextLimit * 2).map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        return role + ': ' + m.content;
      }).join('\n\n');

      const genModel = this.geminiClient.getGenerativeModel({
        model: model,
        systemInstruction: systemPrompt,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperature,
          topP: config.get('ai.topP'),
        },
      });

      const result = await genModel.generateContent(historyBlock + '\n\nAssistant:');
      const response = result.response;
      const reply = typeof response.text === 'function' ? response.text() : (response.text || '');

      if (reply) {
        conv.push({ role: 'assistant', content: reply });
        this._updateContextExpiry(convKey);
      }
      return reply || '...';
    } catch (err) {
      const msg = err.message || '';
      const status = err.status;
      logger.error('Gemini error: [HTTP ' + status + '] ' + msg);

      const lower = msg.toLowerCase();
      if (status === 401 || status === 403 && (lower.includes('api_key') || lower.includes('api key'))) {
        return 'Invalid API key. Press K to set a new one.';
      }
      if (status === 404 || lower.includes('not found') || lower.includes('not supported')) {
        return 'Model "' + model + '" not found. Press M to change it.';
      }
      if (status === 429 || lower.includes('quota') || lower.includes('rate limit') || lower.includes('too many requests')) {
        return 'AI is currently overloaded (quota exceeded). Try again later or switch to a different provider with the P key.';
      }
      if (lower.includes('network') || lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('econnreset')) {
        return 'Network error. Check your internet connection.';
      }
      return 'AI error: ' + msg.substring(0, 200);
    }
  }

  _getConversation(contactId) {
    if (!this.conversations.has(contactId)) {
      this.conversations.set(contactId, {
        messages: [],
        lastActive: Date.now(),
      });
    }
    const conv = this.conversations.get(contactId);
    const expiry = config.get('ai.contextExpiryMinutes') * 60 * 1000;
    if (!conv.lastActive || Date.now() - conv.lastActive > expiry) {
      conv.messages = [];
    }
    conv.lastActive = Date.now();
    return conv.messages;
  }

  _updateContextExpiry(contactId) {
    const conv = this.conversations.get(contactId);
    if (conv) conv.lastActive = Date.now();
  }

  clearConversation(contactId) {
    this.conversations.delete(contactId);
  }

  clearAllConversations() {
    this.conversations.clear();
  }

  _startContextCleanup() {
    this._contextTimer = setInterval(() => {
      const expiry = config.get('ai.contextExpiryMinutes') * 60 * 1000;
      const now = Date.now();
      for (const [id, conv] of this.conversations) {
        if (now - conv.lastActive > expiry) {
          this.conversations.delete(id);
        }
      }
    }, 60000);
  }

  destroy() {
    if (this._contextTimer) clearInterval(this._contextTimer);
    this.conversations.clear();
  }

  async transcribeAudio(base64Data, mimeType) {
    if (this.geminiClient) {
      try {
        const model = this.geminiClient.getGenerativeModel({
          model: 'gemini-2.0-flash',
          generationConfig: { maxOutputTokens: 512, temperature: 0 },
        });
        const result = await model.generateContent([
          'Transcribe this voice message accurately. Return ONLY the transcribed text, nothing else.',
          { inlineData: { data: base64Data, mimeType: mimeType || 'audio/ogg' } },
        ]);
        const text = typeof result.response.text === 'function' ? result.response.text() : (result.response.text || '');
        return text.trim() || null;
      } catch (err) {
        logger.error('Voice transcription failed: ' + err.message);
        return null;
      }
    }
    logger.warn('Voice transcription requires Gemini provider');
    return null;
  }

  async testConnection() {
    const provider = config.get('ai.provider');
    try {
      if (provider === 'gemini') {
        if (!this.geminiClient) return { ok: false, error: 'Gemini not initialized' };
        const model = this.geminiClient.getGenerativeModel({ model: config.get('ai.model') || 'gemini-2.5-pro-preview-03-25' });
        const result = await model.generateContent('Reply with one word: ok');
        const resp = result.response;
        const text = typeof resp.text === 'function' ? resp.text() : (resp.text || '');
        return { ok: true, text };
      }
      if (!this.client) return { ok: false, error: 'Client not initialized' };
      const response = await this.client.chat.completions.create({
        model: config.get('ai.model'),
        messages: [{ role: 'user', content: 'Reply with just: ok' }],
        max_tokens: 5,
      });
      return { ok: true, text: response.choices[0]?.message?.content };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    }
  }
}

module.exports = new AIEngine();
