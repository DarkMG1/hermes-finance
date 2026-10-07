import type { Deps } from './deps.ts';
import { syncAll } from './sync/run.ts';

export function startScheduler(deps: Deps): () => void {
  const tick = () => { syncAll(deps).catch((e: unknown) => console.error(`[hermes] scheduled sync crashed ${(e as Error).name}`)); };
  const timer = setInterval(tick, deps.config.syncIntervalMs).unref();
  const first = setTimeout(tick, 5_000).unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
