// Self-test for the test harness: startServer must fail loudly, with server logs.
import assert from 'node:assert';
import { startServer, makeRunner } from './helpers/harness.js';

const t = makeRunner('Test Harness Self-Test');

await t.it('startServer rejects with captured logs when the server crashes on boot', async () => {
  await assert.rejects(
    startServer({ env: { NODE_OPTIONS: '--require ./definitely-missing-module.cjs' }, timeoutMs: 5000 }),
    err => /exited early/.test(err.message) && /server log/.test(err.message) && /definitely-missing-module/.test(err.message)
  );
});

await t.it('startServer rejects when /api/health never becomes healthy within the timeout', async () => {
  // A preload that never finishes: the process stays alive but the app never starts listening
  await assert.rejects(
    startServer({ env: { NODE_OPTIONS: '--import=data:text/javascript,setInterval(()=>{},1000);await{then(){}}' }, timeoutMs: 1500 }),
    err => /no healthy response within 1500 ms/.test(err.message) && /--- server log ---/.test(err.message)
  );
});

const failed = await t.finish();
process.exit(failed ? 1 : 0);
