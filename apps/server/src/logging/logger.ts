import { formatLoggerActivity } from '../monitor/activityFeed.js';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function debugEnabled() {
  return process.env.GIADA_LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'debug';
}

export const logger: Logger = {
  debug(message, meta) {
    if (debugEnabled()) {
      console.debug(JSON.stringify({ level: 'debug', message, meta, time: new Date().toISOString() }));
    }
  },
  info(message, meta) {
    formatLoggerActivity('info', message, meta);
    console.log(JSON.stringify({ level: 'info', message, meta, time: new Date().toISOString() }));
  },
  warn(message, meta) {
    formatLoggerActivity('warn', message, meta);
    console.warn(JSON.stringify({ level: 'warn', message, meta, time: new Date().toISOString() }));
  },
  error(message, meta) {
    formatLoggerActivity('error', message, meta);
    console.error(JSON.stringify({ level: 'error', message, meta, time: new Date().toISOString() }));
  }
};
