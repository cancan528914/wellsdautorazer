/**
 * Profesyonel log sistemi. Teknik detaylar console'a, kullanıcıya sade mesaj gider.
 */

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

const logger = {
  info(msg) {
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.blue}[INFO]${C.reset} ${msg}`);
  },
  success(msg) {
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.green}[OK]${C.reset} ${msg}`);
  },
  warn(msg) {
    console.warn(`${C.gray}[${timestamp()}]${C.reset} ${C.yellow}[WARN]${C.reset} ${msg}`);
  },
  error(msg, err) {
    console.error(`${C.gray}[${timestamp()}]${C.reset} ${C.red}[ERROR]${C.reset} ${msg}`);
    if (err) {
      // Teknik detay sadece console'a
      console.error(err);
    }
  },
  db(msg) {
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.green}[DB]${C.reset} ${msg}`);
  },
};

module.exports = logger;
