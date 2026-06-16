# Addon And Plugin Developer Guide

Backend plugins implement:

```ts
export interface GiadaPlugin {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Register plugins in `apps/server/src/index.ts` through `PluginManager`.

Rules:

- Plugins must not read `.env` directly. Use typed config from `loadConfig()`.
- Plugins must use `MemoryRepository` for shared memory.
- Plugins must classify or sanitize outputs before crossing into public surfaces.
- Discord plugins must never send private or secret memory unless a policy module transforms it into a safe public summary.
- Long-running plugin work should be cancellable from `stop()`.

Recommended plugin structure:

```text
apps/server/src/plugins/myPlugin/
  myPlugin.ts
  myPlugin.test.ts
```

Expose new AI-callable actions through `apps/server/src/tools/registry.ts`, not directly through plugin internals.
