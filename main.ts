// The entrypoint: the trial lifecycle around the forge's HTTP server.
// Bind an ephemeral port, register it with the env, then poll the env's
// /done until the suite is finished, and exit 0. Nothing else is printed
// or persisted: the trial's whole state lives in the server's memory.

import { createApp } from './src/server.ts';
import { Forge } from './src/store.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  process.exit(1);
}
const base = envUrl.replace(/\/+$/, '');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW);
const server = createApp(forge, token);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST {port} to the env's /register, retrying with backoff until it takes. */
async function register(port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        console.error(`the env refused the registration with HTTP ${response.status}`);
        process.exit(1);
      }
    } catch {
      // The env may not be listening yet; keep trying.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

/** Poll the env's /done until it answers {"done": true}. */
async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A lost poll is retried; the env answers at once when it is up.
    }
    await sleep(200);
  }
}

await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  console.error('the server did not bind a port');
  process.exit(1);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
await register(address.port);
console.error(`registered with the env on port ${address.port}`);
await waitForDone();
server.close();
process.exit(0);
