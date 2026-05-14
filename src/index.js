const logger = require('./logger');
const config = require('./config');
const database = require('./database');
const aiEngine = require('./ai/engine');
const BotManager = require('./manager');
const WebServer = require('./web/server');

const isTTY = process.stdout.isTTY;

const dashboard = (() => {
  if (isTTY) {
    return require('./dashboard/ui');
  }
  const cb = {};
  return {
    callbacks: cb,
    addLog: (msg, lvl) => {
      const icons = { info: '•', warn: '⚠', error: '✖', success: '✓' };
      logger.info('[' + (icons[lvl] || '•') + '] ' + msg);
    },
    addMessage: (direction, contact, text) => {
      logger.info((direction === 'in' ? '←' : '→') + ' ' + contact + ': ' + text.substring(0, 120));
    },
    updateInstanceList: () => {},
    updateStatus: () => {},
    updateSubHeader: () => {},
    updateToggles: () => {},
    updateStats: () => {},
    showQR: () => { logger.info('📱 Scan QR on the web dashboard to link WhatsApp.'); },
    hideQR: () => {},
    setBotInfo: () => {},
    promptInput: () => { logger.warn('Use web dashboard for this in headless mode'); },
    showInstancePromptInput: () => { logger.warn('Use web dashboard for this in headless mode'); },
    on: (event, handler) => { if (!cb[event]) cb[event] = []; cb[event].push(handler); },
    _emit: (event, ...args) => { for (const h of (cb[event] || [])) { try { h(...args); } catch (e) {} } },
    render: () => {},
    destroy: () => {},
  };
})();

const PKG = require('../package.json');
const startTime = Date.now();

let isShuttingDown = false;
let statsInterval = null;
let botManager = null;

function getUptime() {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

async function main() {
  logger.info('WhatsApp AI Bot v' + PKG.version + ' starting...');

  config.load();

  const msgStore = database.collection('messages', { total: 0, sent: 0, received: 0 });
  const chatStore = database.collection('activeChats', {});

  botManager = new BotManager();
  botManager.loadFromConfig();

  dashboard.initialize();

  const webServer = new WebServer(botManager);

  const origAddLog = dashboard.addLog.bind(dashboard);
  dashboard.addLog = (msg, lvl) => {
    origAddLog(msg, lvl);
    if (webServer) webServer.pushLog(msg, lvl);
  };

  dashboard.addLog('Dashboard initialized', 'success');
  dashboard.updateInstanceList(botManager.getInstanceList());

  function reinitAI(desc) {
    aiEngine.destroy();
    const ok = aiEngine.initialize();
    if (!ok) {
      dashboard.addLog('AI re-init failed for ' + desc, 'error');
    } else {
      dashboard.addLog('AI switched to ' + desc, 'success');
    }
    dashboard.updateSubHeader();
  }

  const PROVIDER_CYCLE = ['ollama', 'openai', 'groq', 'gemini', 'custom'];

  dashboard.on('quit', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    dashboard.addLog('Shutting down...', 'warn');
    await shutdown();
  });

  dashboard.on('toggle_bot', () => {
    const v = config.toggle('bot.enabled');
    dashboard.addLog('Bot ' + (v ? 'enabled' : 'disabled'), 'info');
  });

  dashboard.on('toggle_ai', () => {
    const v = config.toggle('bot.aiResponses');
    dashboard.addLog('AI responses ' + (v ? 'enabled' : 'disabled'), 'info');
  });

  dashboard.on('toggle_humanizer', () => {
    const v = config.toggle('humanizer.enabled');
    dashboard.addLog('Humanizer ' + (v ? 'enabled' : 'disabled'), 'info');
  });

  dashboard.on('toggle_whitelist', () => {
    const v = config.toggle('security.whitelistEnabled');
    dashboard.addLog('Whitelist ' + (v ? 'enabled' : 'disabled'), 'info');
  });

  dashboard.on('toggle_groups', () => {
    const v = config.toggle('bot.respondToGroups');
    dashboard.addLog('Group responses ' + (v ? 'enabled' : 'disabled'), 'info');
  });

  dashboard.on('reset_conversations', () => {
    aiEngine.clearAllConversations();
    dashboard.addLog('All conversation contexts cleared', 'info');
  });

  dashboard.on('change_provider', () => {
    const current = config.get('ai.provider');
    const idx = PROVIDER_CYCLE.indexOf(current);
    const next = PROVIDER_CYCLE[(idx + 1) % PROVIDER_CYCLE.length];
    config.set('ai.provider', next);
    if (next === 'gemini') {
      config.set('ai.baseUrl', '');
    } else {
      const urls = { ollama: 'http://localhost:11434/v1', openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1', custom: config.get('ai.baseUrl') || '' };
      if (urls[next]) config.set('ai.baseUrl', urls[next]);
    }
    reinitAI(next + '/' + config.get('ai.model'));
  });

  dashboard.on('show_model_input', () => {
    dashboard.promptInput('Enter model name:', config.get('ai.model'), (value) => {
      if (value && value.trim()) {
        config.set('ai.model', value.trim());
        reinitAI(config.get('ai.provider') + '/' + value.trim());
      }
    });
  });

  dashboard.on('test_connection', async () => {
    dashboard.addLog('Testing AI connection...', 'info');
    const result = await aiEngine.testConnection();
    if (result.ok) {
      dashboard.addLog('✓ Connection OK: ' + (result.text || 'response received'), 'success');
    } else {
      dashboard.addLog('✗ Connection failed: ' + (result.error || 'unknown'), 'error');
    }
  });

  dashboard.on('show_apikey_input', () => {
    dashboard.promptInput('Enter API key:', '', (value) => {
      if (value && value.trim()) {
        config.set('ai.apiKey', value.trim());
        if (!config.get('ai.baseUrl')) {
          config.set('ai.baseUrl', process.env.AI_BASE_URL || 'http://localhost:11434/v1');
        }
        reinitAI(config.get('ai.provider') + '/' + config.get('ai.model'));
        dashboard.addLog('API key updated', 'info');
      }
    });
  });

  dashboard.on('switch_instance_next', () => {
    botManager.switchNext();
    dashboard.updateInstanceList(botManager.getInstanceList());
    const active = botManager.getActiveInstance();
    if (active) {
      const status = active.status || 'disconnected';
      dashboard.updateStatus(status);
      dashboard.addLog('Switched to: ' + active.label, 'info');
    }
  });

  dashboard.on('switch_instance_prev', () => {
    botManager.switchPrev();
    dashboard.updateInstanceList(botManager.getInstanceList());
    const active = botManager.getActiveInstance();
    if (active) {
      const status = active.status || 'disconnected';
      dashboard.updateStatus(status);
      dashboard.addLog('Switched to: ' + active.label, 'info');
    }
  });

  dashboard.on('edit_instance_prompt', () => {
    const active = botManager.getActiveInstance();
    if (!active) {
      dashboard.addLog('No active instance', 'warn');
      return;
    }
    const currentPrompt = active.config.systemPrompt || config.get('ai.systemPrompt');
    dashboard.showInstancePromptInput(currentPrompt, (value) => {
      if (value && value.trim()) {
        active.config.systemPrompt = value.trim();
        if (active.processor) {
          active.processor.instanceConfig.systemPrompt = value.trim();
        }
        config.save();
        dashboard.addLog('System prompt updated for ' + active.label, 'success');
      }
    });
  });

  dashboard.on('restart_instance', async () => {
    const active = botManager.getActiveInstance();
    if (!active) {
      dashboard.addLog('No active instance to restart', 'warn');
      return;
    }
    dashboard.addLog('Restarting ' + active.label + '...', 'info');
    await botManager.stopInstance(active.id);
    await botManager.startInstance(active.id);
    dashboard.addLog(active.label + ' restarted', 'success');
  });

  dashboard.on('toggle_web', async () => {
    if (webServer.running) {
      webServer.stop();
      dashboard.addLog('Web server stopped', 'info');
    } else {
      try {
        await webServer.start();
        dashboard.addLog('Web server started at ' + webServer.getUrl(), 'success');
        const { exec } = require('child_process');
        exec('start "" "' + webServer.getUrl() + '"', (err) => {
          if (err) logger.warn('Could not open browser: ' + err.message);
        });
      } catch (err) {
        dashboard.addLog('Web server failed: ' + err.message, 'error');
      }
    }
  });

  const aiOk = aiEngine.initialize();
  if (!aiOk) {
    dashboard.addLog('AI engine initialization failed. Check your .env configuration.', 'error');
  } else {
    dashboard.addLog('AI engine initialized (' + config.get('ai.provider') + '/' + config.get('ai.model') + ')', 'success');
  }

  dashboard.updateSubHeader();
  dashboard.updateToggles();

  botManager.on('instance_qr', ({ instanceId, label, qrString }) => {
    const active = botManager.getActiveInstance();
    if (active && active.id === instanceId) {
      dashboard.updateStatus('awaiting_qr');
      dashboard.showQR(qrString);
      dashboard.addLog('[' + label + '] QR code generated - scan the opened image', 'info');
    } else {
      dashboard.addLog('[' + label + '] QR available (switch to see it)', 'info');
    }
  });

  botManager.on('instance_status', ({ instanceId, label, status }) => {
    const active = botManager.getActiveInstance();
    dashboard.updateInstanceList(botManager.getInstanceList());
    if (active && active.id === instanceId) {
      dashboard.updateStatus(status);
    }
    if (status === 'connected') {
      dashboard.addLog('[' + label + '] Connected', 'success');
      dashboard.hideQR();
    } else if (status === 'disconnected') {
      dashboard.addLog('[' + label + '] Disconnected', 'error');
    } else if (status === 'error') {
      dashboard.addLog('[' + label + '] Connection error', 'error');
    }
  });

  botManager.on('instance_ready', ({ instanceId, label, info }) => {
    if (botManager.activeId === instanceId) {
      dashboard.setBotInfo(info);
      dashboard.updateSubHeader();
    }
  });

  botManager.on('instance_message', ({ instanceId, label, direction, contact, text }) => {
    if (text) {
      dashboard.addMessage(direction, '[' + label + '] ' + contact, text);
      webServer.pushMessage(direction, '[' + label + '] ' + contact, text);
    }
  });

  botManager.on('active_changed', ({ instanceId, label }) => {
    const active = botManager.getActiveInstance();
    if (active) {
      dashboard.updateStatus(active.status);
      dashboard.setBotInfo(label);
      dashboard.updateSubHeader();
      if (active.status === 'awaiting_qr' && active.qrCodeString) {
        dashboard.showQR(active.qrCodeString);
      } else if (active.status === 'connected') {
        dashboard.hideQR();
      }
    }
    dashboard.updateInstanceList(botManager.getInstanceList());
  });

  if (!isTTY && !webServer.running) {
    try {
      await webServer.start();
      dashboard.addLog('Web server auto-started at ' + webServer.getUrl(), 'success');
    } catch (err) {
      dashboard.addLog('Web server failed: ' + err.message, 'error');
    }
  }

  dashboard.addLog('Starting ' + botManager.instances.size + ' instance(s)...', 'info');

  await botManager.startAll();

  if (botManager.instances.size > 0) {
    const active = botManager.getActiveInstance();
    if (active) {
      dashboard.updateStatus(active.status);
    }
  }

  statsInterval = setInterval(() => {
    if (isShuttingDown) return;
    const msgs = msgStore.get();
    const chats = Object.keys(chatStore.get()).length;
    dashboard.updateStats({
      sent: msgs.sent || 0,
      received: msgs.received || 0,
      activeChats: chats,
      uptime: getUptime(),
    });
    dashboard.updateToggles();
    dashboard.updateSubHeader();
    dashboard.updateInstanceList(botManager.getInstanceList());

    const active = botManager.getActiveInstance();
    if (active) {
      const client = active.client;
      if (client) {
        const status = client.getStatus();
        const statusMap = {
          'connected': 'connected',
          'authenticated': 'connected',
        };
        dashboard.updateStatus(statusMap[status] || status);
      }
      if (active.status === 'connected') {
        dashboard.hideQR();
      }
    }
  }, 1000);

  dashboard.addLog('Bot is running. Press Q to quit.', 'success');
  logger.info('Bot fully initialized in ' + getUptime());
}

async function shutdown() {
  logger.info('Shutting down...');
  dashboard.addLog('Shutting down gracefully...', 'warn');

  if (statsInterval) clearInterval(statsInterval);

  try {
    database.flushAll();
  } catch (err) {
    logger.error('Flush error: ' + err.message);
  }

  try {
    aiEngine.destroy();
  } catch (err) {}

  try {
    if (botManager) await botManager.stopAll();
  } catch (err) {}

  try {
    dashboard.destroy();
  } catch (err) {}

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception: ' + err.message + '\n' + err.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection: ' + (reason?.message || reason));
});

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await shutdown();
});

process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await shutdown();
});

main().catch((err) => {
  logger.error('Fatal error: ' + err.message + '\n' + err.stack);
  process.exit(1);
});
