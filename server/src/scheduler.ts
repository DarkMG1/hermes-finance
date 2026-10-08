import type { Deps } from './deps.ts';
import { syncAll } from './sync/run.ts';

// Returns stop(): clears the timers and resolves once any in-flight scheduled sync has finished.
export function startScheduler(deps: Deps): () => Promise<void> {
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = () => {
    inFlight = Promise.all([inFlight, syncAll(deps).catch((e: unknown) => console.error(`[hermes] scheduled sync crashed ${(e as Error).name}`))]);
  };
  const timer = setInterval(tick, deps.config.syncIntervalMs).unref();
  const first = setTimeout(tick, 5_000).unref();
  return async () => { clearInterval(timer); clearTimeout(first); await inFlight; };
}
