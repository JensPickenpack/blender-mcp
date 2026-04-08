import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logFile = path.resolve(moduleDir, 'server-debug.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ')}\n`;
  try { fs.appendFileSync(logFile, line); } catch (e) { /* ignore */ }
  try { process.stderr.write(line); } catch (e) { /* ignore */ }
}

log('start-debug: node execPath=', process.execPath);
log('start-debug: cwd=', process.cwd());
log('start-debug: argv=', process.argv);

process.on('uncaughtException', (err) => {
  log('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection', reason);
});

(async () => {
  try {
    log('start-debug: importing index.js');
    await import('../index.js');
    log('start-debug: import completed');
  } catch (err) {
    log('start-debug: import error', err);
    try { console.error('start-debug import error', err); } catch {}
    process.exit(1);
  }
})();
