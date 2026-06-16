import { logger } from '../logging/logger.js';

export interface GiadaPlugin {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class PluginManager {
  private readonly plugins: GiadaPlugin[] = [];

  register(plugin: GiadaPlugin) {
    this.plugins.push(plugin);
  }

  async startAll() {
    for (const plugin of this.plugins) {
      try {
        await plugin.start();
      } catch (error) {
        logger.error(`Plugin failed to start: ${plugin.name}`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async stopAll() {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.stop();
      } catch (error) {
        logger.error(`Plugin failed to stop: ${plugin.name}`, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
