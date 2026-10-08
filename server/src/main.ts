import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { createPlaidClient } from './plaid/client.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './scheduler.ts';

export async function start(env: NodeJS.ProcessEnv): Promise<{ close: () => Promise<void>; port: number }> {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  migrate(db);
  const deps = { db, config, plaid: createPlaidClient(config), now: () => new Date() };
  const app = buildApp(deps);
  await app.listen({ host: config.host, port: config.port });
  const stop = startScheduler(deps);
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`[hermes] listening on ${config.host}:${port} sha=${config.gitSha}`);
  return {
    port,
    close: async () => { await stop(); await app.close(); db.close(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start(process.env).then((s) => {
    const shutdown = () => { s.close().finally(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((e: unknown) => {
    console.error(`[hermes] failed to start: ${(e as Error).message}`);
    process.exit(1);
  });
}
