export type Config = {
  dbPath: string;
  apiToken: string;
  tokenKey: Buffer;
  host: string;
  port: number;
  syncIntervalMs: number;
  gitSha: string;
  plaid: { clientId: string; secret: string; env: 'sandbox' | 'production' };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiToken = required(env, 'HERMES_API_TOKEN');
  if (apiToken.length < 32) throw new Error('HERMES_API_TOKEN must be at least 32 characters');
  const tokenKey = Buffer.from(required(env, 'HERMES_TOKEN_KEY'), 'base64');
  if (tokenKey.length !== 32) throw new Error('HERMES_TOKEN_KEY must be 32 bytes, base64-encoded');
  const plaidEnv = env.PLAID_ENV ?? 'production';
  if (plaidEnv !== 'sandbox' && plaidEnv !== 'production') throw new Error('PLAID_ENV must be sandbox or production');
  return {
    dbPath: required(env, 'HERMES_DB_PATH'),
    apiToken,
    tokenKey,
    host: env.HERMES_HOST ?? '127.0.0.1',
    port: Number(env.HERMES_PORT ?? 5010),
    syncIntervalMs: Number(env.HERMES_SYNC_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    gitSha: env.HERMES_GIT_SHA ?? 'dev',
    plaid: { clientId: required(env, 'PLAID_CLIENT_ID'), secret: required(env, 'PLAID_SECRET'), env: plaidEnv },
  };
}
