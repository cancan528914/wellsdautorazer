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

const DEBUG_ON = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_DEBUG || '').trim().toLowerCase(),
);

const logger = {
  info(msg) {
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.blue}[INFO]${C.reset} ${msg}`);
  },
  // Teşhis seviyesi. Üretimde sessiz (spam yapmaz); GUARD_DEBUG gibi
  // bayraklarla açılan akışlar sadece burayı kullanır.
  debug(msg) {
    if (process.env.LOG_DEBUG === 'true') {
      console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.gray}[DEBUG]${C.reset} ${msg}`);
    }
  },
  success(msg) {
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.green}[OK]${C.reset} ${msg}`);
  },
  warn(msg) {
    console.warn(`${C.gray}[${timestamp()}]${C.reset} ${C.yellow}[WARN]${C.reset} ${msg}`);
  },
  // Debug seviyesi: varsayilan KAPALI. .env icine LOG_DEBUG=true yazarak acilir.
  debug(msg, err) {
    if (!DEBUG_ON) return;
    console.log(`${C.gray}[${timestamp()}]${C.reset} ${C.gray}[DEBUG]${C.reset} ${msg}`);
    if (err) console.error(err);
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
