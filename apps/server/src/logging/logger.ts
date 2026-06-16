export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export const logger: Logger = {
  info(message, meta) {
    console.log(JSON.stringify({ level: 'info', message, meta, time: new Date().toISOString() }));
  },
  warn(message, meta) {
    console.warn(JSON.stringify({ level: 'warn', message, meta, time: new Date().toISOString() }));
  },
  error(message, meta) {
    console.error(JSON.stringify({ level: 'error', message, meta, time: new Date().toISOString() }));
  }
};
