const blessed = require('blessed');
const config = require('../config');
const logger = require('../logger');

class Dashboard {
  constructor() {
    this.screen = null;
    this.elements = {};
    this.messageBuffer = [];
    this.logBuffer = [];
    this.isRunning = false;
    this.updateTimer = null;
    this.callbacks = {};
    this.modalActive = false;
  }

  initialize() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'WA AI Bot',
      dockBorders: true,
      fullUnicode: true,
      sendFocus: true,
      terminal: process.env.TERM || 'xterm-256color',
    });

    this.screen.key(['q', 'Q', 'C-c'], () => {
      this._emit('quit');
    });

    this.screen.key(['b', 'B'], () => {
      this._emit('toggle_bot');
    });

    this.screen.key(['a', 'A'], () => {
      this._emit('toggle_ai');
    });

    this.screen.key(['h', 'H'], () => {
      this._emit('toggle_humanizer');
    });

    this.screen.key(['w', 'W'], () => {
      this._emit('toggle_whitelist');
    });

    this.screen.key(['r', 'R'], () => {
      this._emit('reset_conversations');
    });

    this.screen.key(['t', 'T'], () => {
      if (this.modalActive) return;
      this._emit('test_connection');
    });

    this.screen.key(['z', 'Z'], () => {
      this._emit('toggle_groups');
    });

    this.screen.key(['p', 'P'], () => {
      if (this.modalActive) return;
      this._emit('change_provider');
    });

    this.screen.key(['m', 'M'], () => {
      if (this.modalActive) return;
      this._emit('show_model_input');
    });

    this.screen.key(['k', 'K'], () => {
      if (this.modalActive) return;
      this._emit('show_apikey_input');
    });

    this.screen.key(['['], () => {
      if (this.modalActive) return;
      this._emit('switch_instance_prev');
    });

    this.screen.key([']'], () => {
      if (this.modalActive) return;
      this._emit('switch_instance_next');
    });

    this.screen.key(['s', 'S'], () => {
      if (this.modalActive) return;
      this._emit('edit_instance_prompt');
    });

    this.screen.key(['o', 'O'], () => {
      if (this.modalActive) return;
      this._emit('toggle_web');
    });

    this.screen.key(['C-r'], () => {
      if (this.modalActive) return;
      this._emit('restart_instance');
    });

    this.screen.key(['tab'], () => {
      this.screen.focusNext();
    });

    this._buildLayout();
    this.isRunning = true;
  }

  _buildLayout() {
    const screen = this.screen;

    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      style: { fg: 'white', bg: 'blue' },
    });
    this.elements.header = header;

    const headerTitle = blessed.text({
      parent: header,
      top: 0,
      left: 2,
      content: ' ◈ WhatsApp AI Bot ',
      style: { fg: 'white', bg: 'blue', bold: true },
    });
    this.elements.headerTitle = headerTitle;

    const headerStatus = blessed.text({
      parent: header,
      top: 0,
      right: 2,
      content: '',
      style: { fg: 'green', bg: 'blue' },
    });
    this.elements.headerStatus = headerStatus;

    const headerSub = blessed.text({
      parent: header,
      top: 1,
      left: 2,
      content: '',
      style: { fg: 'cyan', bg: 'blue' },
    });
    this.elements.headerSub = headerSub;

    const separatorLine = blessed.line({
      parent: screen,
      top: 3,
      left: 0,
      width: '100%',
      type: 'line',
      orientation: 'horizontal',
      style: { fg: 'blue' },
    });

    const leftPanel = blessed.box({
      parent: screen,
      top: 4,
      left: 0,
      width: '35%',
      height: '100%-7',
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line', fg: 'cyan' },
      scrollable: true,
      scrollbar: { style: { bg: 'cyan' } },
    });
    this.elements.leftPanel = leftPanel;

    const instanceTitle = blessed.text({
      parent: leftPanel,
      top: 0,
      left: 1,
      content: '◆ INSTANCES',
      style: { fg: 'yellow', bold: true },
    });
    this.elements.instanceTitle = instanceTitle;

    this.elements.instanceContent = blessed.text({
      parent: leftPanel,
      top: 1,
      left: 2,
      right: 1,
      height: 3,
      content: '  No instances',
      style: { fg: 'white' },
    });

    const controlTitle = blessed.text({
      parent: leftPanel,
      top: 5,
      left: 1,
      content: '─── CONTROL ───',
      style: { fg: 'yellow', bold: true },
    });
    this.elements.controlTitle = controlTitle;

    this.elements.toggles = {};
    const toggleDefs = [
      { key: 'botStatus', label: 'Bot', action: 'toggle_bot', default: true },
      { key: 'aiStatus', label: 'AI Resp.', action: 'toggle_ai', default: true },
      { key: 'humanizerStatus', label: 'Humanizer', action: 'toggle_humanizer', default: true },
      { key: 'whitelistStatus', label: 'Whitelist', action: 'toggle_whitelist', default: false },
      { key: 'groupStatus', label: 'Groups', action: 'toggle_groups', default: false },
    ];

    toggleDefs.forEach((def, i) => {
      const y = 7 + i;
      const label = blessed.text({
        parent: leftPanel,
        top: y,
        left: 2,
        content: def.label,
        style: { fg: 'white' },
      });
      const toggle = blessed.text({
        parent: leftPanel,
        top: y,
        right: 2,
        content: def.default ? '● ON' : '○ OFF',
        style: { fg: def.default ? 'green' : 'red' },
      });
      this.elements.toggles[def.key] = { label, toggle };
    });

    const statsTitleY = 7 + toggleDefs.length + 1;
    const statsTitle = blessed.text({
      parent: leftPanel,
      top: statsTitleY,
      left: 1,
      content: '─── STATS ───',
      style: { fg: 'yellow', bold: true },
    });

    const statDefs = [
      { key: 'sentStat', label: 'Sent:', top: statsTitleY + 1 },
      { key: 'receivedStat', label: 'Recv:', top: statsTitleY + 2 },
      { key: 'chatsStat', label: 'Chats:', top: statsTitleY + 3 },
      { key: 'uptimeStat', label: 'Uptime:', top: statsTitleY + 4 },
    ];

    this.elements.stats = {};
    statDefs.forEach((def) => {
      const label = blessed.text({
        parent: leftPanel,
        top: def.top,
        left: 3,
        content: def.label,
        style: { fg: 'cyan' },
      });
      const value = blessed.text({
        parent: leftPanel,
        top: def.top,
        right: 2,
        content: '0',
        style: { fg: 'white' },
      });
      this.elements.stats[def.key] = { label, value };
    });

    const controlsHelpY = statsTitleY + 6;
    const controlsHelp = blessed.text({
      parent: leftPanel,
      top: controlsHelpY,
      left: 1,
      content: ' B:Bot A:AI H:Human W:White\n Z:Grp R:Reset Q:Quit T:Test\n P:Prov M:Model K:Key S:IPrompt\n [:Prev ]:Next O:Web ^R:Rstrt',
      style: { fg: '#666' },
    });

    const rightPanel = blessed.box({
      parent: screen,
      top: 4,
      left: '35%',
      width: '65%',
      height: '100%-7',
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line', fg: 'cyan' },
      scrollable: true,
      scrollbar: { style: { bg: 'cyan' } },
    });
    this.elements.rightPanel = rightPanel;

    const msgTitle = blessed.text({
      parent: rightPanel,
      top: 0,
      left: 1,
      content: '◆ MESSAGE LOG',
      style: { fg: 'yellow', bold: true },
    });
    this.elements.msgTitle = msgTitle;

    const logPanel = blessed.box({
      parent: screen,
      top: '100%-3',
      left: 0,
      width: '100%',
      height: 3,
      padding: { left: 1, right: 1 },
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line', fg: 'cyan' },
      scrollable: true,
      scrollbar: { style: { bg: 'cyan' } },
    });
    this.elements.logPanel = logPanel;

    const logTitle = blessed.text({
      parent: logPanel,
      top: 0,
      left: 1,
      content: '◆ SYSTEM LOG',
      style: { fg: 'yellow', bold: true },
    });
    this.elements.logTitle = logTitle;

    this.elements.logContent = blessed.text({
      parent: logPanel,
      top: 1,
      left: 1,
      content: '',
      style: { fg: '#888' },
    });

    const qrBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '60%',
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line', fg: 'green' },
      hidden: true,
      tags: true,
      content: '',
      align: 'center',
      valign: 'middle',
    });
    this.elements.qrBox = qrBox;

    const qrTitle = blessed.text({
      parent: qrBox,
      top: 0,
      left: 1,
      content: '◆ SCAN QR CODE',
      style: { fg: 'yellow', bold: true },
    });

    this.elements.qrInstructions = blessed.text({
      parent: qrBox,
      top: '100%-4',
      left: 2,
      right: 2,
      content: 'A QR image should open in your browser.\nScan it with WhatsApp > Linked Devices.',
      style: { fg: 'cyan', bold: true },
      align: 'center',
    });

    this.elements.qrContent = blessed.box({
      parent: qrBox,
      top: 2,
      left: 2,
      right: 2,
      bottom: 4,
      content: '',
      style: { fg: 'green' },
      scrollable: true,
    });

    const inputOverlay = blessed.box({
      parent: screen,
      top: 0, left: 0, width: '100%', height: '100%',
      style: { bg: 'black' },
      hidden: true,
      tags: true,
    });
    this.elements.inputOverlay = inputOverlay;

    const inputModal = blessed.box({
      parent: screen,
      top: 'center', left: 'center',
      width: '55%', height: 8,
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'white', bg: 'black' },
      hidden: true,
      tags: true,
      shadow: true,
    });
    this.elements.inputModal = inputModal;

    this.elements.inputLabel = blessed.text({
      parent: inputModal,
      top: 0, left: 1,
      content: '',
      style: { fg: 'yellow', bold: true },
    });

    this.elements.inputField = blessed.textbox({
      parent: inputModal,
      top: 2, left: 1, right: 1, height: 3,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'blue', focus: { bg: 'blue' } },
      value: '',
    });

    this.elements.inputHint = blessed.text({
      parent: inputModal,
      top: 5, left: 1,
      content: 'Enter to confirm  |  Esc to cancel',
      style: { fg: '#666' },
    });

    this.elements.inputField.on('submit', (value) => {
      const cb = this._inputCallback;
      this._hideInputModal();
      if (cb) cb(value || null);
    });

    this.elements.inputField.key('escape', () => {
      const cb = this._inputCallback;
      this._hideInputModal();
      if (cb) cb(null);
    });

    this.screen.render();
  }

  _showInputModal(label, currentValue, callback) {
    this._inputCallback = callback;
    this.elements.inputLabel.setContent('◆ ' + label);
    this.elements.inputField.setValue(currentValue || '');
    this.elements.inputOverlay.show();
    this.elements.inputModal.show();
    this.modalActive = true;
    this.elements.inputField.focus();
    this.screen.render();
  }

  _hideInputModal() {
    this.elements.inputOverlay.hide();
    this.elements.inputModal.hide();
    this.modalActive = false;
    this._inputCallback = null;
    this.screen.render();
  }

  showQR(qrString) {
    if (!this.elements.qrBox) return;
    this.elements.qrContent.setContent(qrString);
    this.elements.qrBox.show();
    this.screen.render();
  }

  hideQR() {
    if (!this.elements.qrBox) return;
    this.elements.qrBox.hide();
    this.screen.render();
  }

  addLog(message, level = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const icons = { info: '•', warn: '⚠', error: '✖', success: '✓', debug: '›' };
    const icon = icons[level] || '•';
    const entry = `[${time}] ${icon} ${message}`;

    this.logBuffer.push(entry);
    const maxLogs = 2;
    if (this.logBuffer.length > maxLogs) {
      this.logBuffer.shift();
    }

    if (this.elements.logContent) {
      this.elements.logContent.setContent(this.logBuffer.join('\n'));
      this.screen.render();
    }
  }

  addMessage(direction, contact, content) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefix = direction === 'in'
      ? `{green-fg}[${time}]{/green-fg} {white-fg}${contact}{/white-fg}`
      : `{cyan-fg}[${time}]{/cyan-fg} {cyan-fg}Bot → ${contact}{/cyan-fg}`;
    const truncated = content.length > 80 ? content.substring(0, 80) + '...' : content;

    this.messageBuffer.push({ prefix, content: truncated, direction });
    const maxMsgs = config.get('dashboard.maxMessageLines');
    if (this.messageBuffer.length > maxMsgs) {
      this.messageBuffer.shift();
    }

    let rendered = '';
    for (const msg of this.messageBuffer) {
      rendered += msg.prefix + '\n';
      rendered += '  ' + msg.content + '\n\n';
    }

    if (this.elements.rightPanel) {
      const msgText = blessed.text({
        parent: this.elements.rightPanel,
        top: 1,
        left: 1,
        content: rendered || 'Awaiting messages...',
        style: { fg: 'white' },
        tags: true,
      });

      const existing = this.elements.msgContent;
      if (existing) existing.detach();

      this.elements.msgContent = msgText;
      this.elements.rightPanel.setScrollPerc(100);
      this.screen.render();
    }
  }

  updateStatus(status) {
    if (this.elements.headerStatus) {
      const icons = {
        connected: '{green-fg}● Connected{/green-fg}',
        disconnected: '{red-fg}● Disconnected{/red-fg}',
        awaiting_qr: '{yellow-fg}● Scan QR{/yellow-fg}',
        authenticated: '{cyan-fg}● Authenticated{/cyan-fg}',
        auth_failed: '{red-fg}● Auth Failed{/red-fg}',
        error: '{red-fg}● Error{/red-fg}',
      };
      this.elements.headerStatus.setContent(icons[status] || '● ' + status);
    }
    this.screen.render();
  }

  updateSubHeader() {
    const me = this._botInfo || 'Not connected';
    const humanizer = config.get('humanizer.enabled') ? 'ON' : 'OFF';
    const provider = config.get('ai.provider');
    const model = config.get('ai.model');
    if (this.elements.headerSub) {
      this.elements.headerSub.setContent(` ${me}  |  Humanizer: ${humanizer}  |  ${provider}/${model}`);
    }
    this.screen.render();
  }

  updateToggles() {
    const botEnabled = config.get('bot.enabled');
    const aiEnabled = config.get('bot.aiResponses');
    const humanizer = config.get('humanizer.enabled');
    const whitelist = config.get('security.whitelistEnabled');
    const groups = config.get('bot.respondToGroups');

    const toggles = {
      botStatus: botEnabled,
      aiStatus: aiEnabled,
      humanizerStatus: humanizer,
      whitelistStatus: whitelist,
      groupStatus: groups,
    };

    for (const [key, enabled] of Object.entries(toggles)) {
      const el = this.elements.toggles[key];
      if (el) {
        el.toggle.setContent(enabled ? '● ON' : '○ OFF');
        el.toggle.style.fg = enabled ? 'green' : 'red';
      }
    }
    this.screen.render();
  }

  updateStats(stats) {
    const labels = {
      sentStat: (stats.sent || 0).toString(),
      receivedStat: (stats.received || 0).toString(),
      chatsStat: (stats.activeChats || 0).toString(),
      uptimeStat: stats.uptime || '0m',
    };

    for (const [key, val] of Object.entries(labels)) {
      const el = this.elements.stats[key];
      if (el) el.value.setContent(val);
    }
    this.screen.render();
  }

  promptInput(label, currentValue, callback) {
    this._showInputModal(label, currentValue, callback);
  }

  setBotInfo(info) {
    this._botInfo = info;
  }

  updateInstanceList(instances) {
    if (!this.elements.instanceContent) return;
    if (!instances || instances.length === 0) {
      this.elements.instanceContent.setContent('  No instances');
      this.screen.render();
      return;
    }
    const lines = instances.map((inst) => {
      const statusIcons = {
        connected: '{green-fg}●{/green-fg}',
        connecting: '{yellow-fg}○{/yellow-fg}',
        awaiting_qr: '{yellow-fg}◈{/yellow-fg}',
        disconnected: '{red-fg}●{/red-fg}',
        error: '{red-fg}✖{/red-fg}',
        stopped: '{#666}○{/#666}',
      };
      const icon = statusIcons[inst.status] || '{#666}○{/#666}';
      const arrow = inst.active ? '{cyan-fg}▸{/cyan-fg}' : ' ';
      return ` ${arrow} ${icon} {bold}${inst.label}{/bold}`;
    });
    this.elements.instanceContent.setContent(lines.join('\n'));
    this.screen.render();
  }

  showInstancePromptInput(currentPrompt, callback) {
    this._showInputModal('System prompt for active instance:', currentPrompt, callback);
  }

  on(event, handler) {
    if (!this.callbacks[event]) this.callbacks[event] = [];
    this.callbacks[event].push(handler);
  }

  _emit(event, ...args) {
    const handlers = this.callbacks[event] || [];
    for (const handler of handlers) {
      try { handler(...args); } catch (err) { logger.error('Dashboard handler error: ' + err.message); }
    }
  }

  render() {
    if (this.screen) this.screen.render();
  }

  destroy() {
    this.isRunning = false;
    if (this.updateTimer) clearInterval(this.updateTimer);
    if (this.screen) {
      this.screen.destroy();
    }
  }
}

module.exports = new Dashboard();
