const config = require('../config');
const { MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

class RulesEngine {
  check(messageText) {
    if (!config.get('rules.enabled')) return null;
    const items = config.get('rules.items') || [];
    for (const rule of items) {
      if (!rule.enabled) continue;
      if (!rule.keywords || rule.keywords.length === 0) continue;

      const lower = messageText.toLowerCase();
      let matched = false;

      if (rule.matchType === 'all') {
        matched = rule.keywords.every((kw) => lower.includes(kw.toLowerCase()));
      } else if (rule.matchType === 'regex') {
        try {
          matched = rule.keywords.some((kw) => new RegExp(kw, 'i').test(lower));
        } catch (e) {
          logger.warn('Invalid regex in rule "' + rule.name + '": ' + kw);
        }
      } else {
        matched = rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
      }

      if (matched) {
        logger.info('Rule matched: ' + rule.name);
        return rule.response;
      }
    }
    return null;
  }

  resolveMedia(response) {
    if (response.type === 'image' || response.type === 'file') {
      const filePath = response.path;
      if (!filePath) return null;
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        logger.warn('Media file not found: ' + resolved);
        return null;
      }
      try {
        const data = fs.readFileSync(resolved, { encoding: 'base64' });
        const ext = path.extname(resolved).toLowerCase();
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.pdf': 'application/pdf',
          '.mp4': 'video/mp4',
          '.mp3': 'audio/mpeg',
          '.ogg': 'audio/ogg',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        const mimetype = mimeMap[ext] || 'application/octet-stream';
        const filename = path.basename(resolved);
        return new MessageMedia(mimetype, data, filename);
      } catch (err) {
        logger.error('Failed to load media: ' + err.message);
        return null;
      }
    }
    return null;
  }
}

module.exports = new RulesEngine();
