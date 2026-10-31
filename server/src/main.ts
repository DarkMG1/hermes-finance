import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { markInterruptedReads } from './inbox.ts';
import { createPlaidClient } from './plaid/client.ts';
import { createTiingoClient } from './prices/tiingo.ts';
import { createAnthropicReader } from './receipt-reader/anthropic.ts';
import { createClaude } from './chat/anthropic.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './scheduler.ts';

export async function start(env: NodeJS.ProcessEnv): Promise<{ close: () => Promise<void>; port: number }> {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  migrate(db);
  markInterruptedReads(db);
  if (!config.tiingoApiKey) console.log('[hermes] no TIINGO_API_KEY: investment prices are off');
  if (!config.anthropicApiKey) console.log('[hermes] no ANTHROPIC_API_KEY: receipt reading is off');
  const now = () => new Date();
  const claude = createClaude({ db, config, now });
  const deps = { db, config, plaid: createPlaidClient(config), prices: config.tiingoApiKey ? createTiingoClient(config.tiingoApiKey) : null,
    receiptReader: claude ? createAnthropicReader(claude, config.anthropicModel) : null, claude, now };
  const app = buildApp(deps);
  await app.listen({ host: config.host, port: config.port });
  const stop = startScheduler(deps);
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`[hermes] time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
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
