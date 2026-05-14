const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DATA_DIR = path.resolve('data');

class Database {
  constructor() {
    this.cache = {};
    this.writeQueue = new Map();
    this.writeTimer = null;
  }

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _filePath(name) {
    return path.join(DATA_DIR, name + '.json');
  }

  _read(name) {
    const fp = this._filePath(name);
    try {
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.error(`Failed to read ${name}.json: ${err.message}`);
    }
    return null;
  }

  _write(name, data) {
    const fp = this._filePath(name);
    try {
      this._ensureDir();
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, fp);
      return true;
    } catch (err) {
      logger.error(`Failed to write ${name}.json: ${err.message}`);
      return false;
    }
  }

  _debouncedWrite(name) {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      for (const [n, data] of this.writeQueue) {
        this._write(n, data);
      }
      this.writeQueue.clear();
      this.writeTimer = null;
    }, 500);
  }

  collection(name, defaults = {}) {
    if (!this.cache[name]) {
      const data = this._read(name);
      this.cache[name] = data !== null ? data : defaults;
    }
    const self = this;
    return {
      get() {
        return self.cache[name];
      },
      set(data) {
        self.cache[name] = data;
        self.writeQueue.set(name, data);
        self._debouncedWrite(name);
      },
      update(fn) {
        const data = fn(self.cache[name]);
        self.cache[name] = data;
        self.writeQueue.set(name, data);
        self._debouncedWrite(name);
      },
      flush() {
        self._write(name, self.cache[name]);
      },
    };
  }

  flushAll() {
    for (const [name, data] of Object.entries(this.cache)) {
      this._write(name, data);
    }
    logger.info('All data flushed to disk');
  }
}

module.exports = new Database();
