// REAL-BROWSER session regression suite for the P1 "old room comes back" bug.
// Real React production build + real Worker/Durable Objects in local workerd + headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker, startFrontend, launchChrome, trackErrors, distDir } from './harness.js';
import { sleep, waitLanding, roomCodeShown, waitRoom, createRoomUI, joinRoomUI, leaveUI, signOutUI, claimUI, watchRoomCodes } from './ui.js';

const shotsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'playback_screenshots', 'session');

test('Session lifecycle in real browsers (refresh, leave, create, join, tabs, logout, restarts)', { timeout: 420000 }, async (t) => {
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'build client/dist first (npm run test:e2e does this)');
  fs.mkdirSync(shotsDir, { recursive: true });
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-do-'));
  let worker = await startWorker({ persistDir: persist });
  const fe = await startFrontend(worker);
  const browser = await launchChrome();
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const errors = [];
  t.after(async () => {
    await browser.close().catch(() => {});
    await fe.close();
    await worker.mf.dispose().catch(() => {});
    fs.rmSync(persist, { recursive: true, force: true });
  });

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  trackErrors(page, errors, 'main');
  await page.goto(fe.url);

  let A, B;
  await t.test('1. create Room A, claim a franchise, refresh restores the same room + franchise', async () => {
    A = await createRoomUI(page, 'Nisha');
    await claimUI(page, 'CSK');
    await page.reload();
    await waitRoom(page, A);
    await page.getByTestId('lobby-franchise-CSK').getByText('Your Franchise').waitFor({ timeout: 10000 });
    assert.match(await page.getByTestId('claimed-count').innerText(), /^1 \/ 10/, 'no duplicate participant/claim');
    await page.screenshot({ path: path.join(shotsDir, '01-room-a-restored.png') });
  });

  await t.test('2. EXACT BUG: leave A, create B → B opens and A never appears', async () => {
    await leaveUI(page);
    assert.equal(await roomCodeShown(page), null);
    await sleep(1500); // give any stale reconnect a chance to misbehave
    assert.equal(await page.getByTestId('resume-card').count(), 0, 'explicit leave removes the resume offer');
    assert.equal(await roomCodeShown(page), null, 'nothing reopened by itself');
    const { result, seen } = await watchRoomCodes(page, () => createRoomUI(page, 'Nisha'));
    B = result;
    assert.notEqual(B, A);
    assert.deepEqual(seen, [B], `room codes shown during creation: ${seen.join(',')}`);
    await page.screenshot({ path: path.join(shotsDir, '02-room-b-after-leave.png') });
  });

  await t.test('3. refresh B restores B; leave B; explicit join A opens A only after that action', async () => {
    await page.reload();
    await waitRoom(page, B);
    await leaveUI(page);
    await sleep(1000);
    assert.equal(await roomCodeShown(page), null);
    await joinRoomUI(page, 'Nisha', A);
    await page.getByTestId('lobby-franchise-CSK').getByText('Your Franchise').waitFor({ timeout: 10000 });
  });

  await t.test('4. repeat the leave → create → refresh → leave → join cycle 3 times', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) {
      await leaveUI(page);
      const { result: C, seen } = await watchRoomCodes(page, () => createRoomUI(page, 'Nisha'));
      assert.deepEqual(seen, [C]);
      created.push(C);
      await page.reload();
      await waitRoom(page, C);
      await leaveUI(page);
      await joinRoomUI(page, 'Nisha', A);
      assert.equal(await roomCodeShown(page), A);
    }
    assert.equal(new Set(created).size, 3);
  });

  await t.test('5. browser back/forward: same-tab history restores the active room; after leave it does not', async () => {
    await page.goto('about:blank');
    await page.goBack();
    await waitRoom(page, A);
    await leaveUI(page);
    await page.goto('about:blank');
    await page.goBack();
    await waitLanding(page);
    await sleep(1200);
    assert.equal(await roomCodeShown(page), null);
    await page.goForward(); await page.goBack();
    await waitLanding(page);
    assert.equal(await roomCodeShown(page), null);
    await joinRoomUI(page, 'Nisha', A);
  });

  await t.test('6. multiple tabs: a new tab never inherits another tab\'s room; tabs keep their own rooms across refresh', async () => {
    const tab2 = await ctx.newPage();
    trackErrors(tab2, errors, 'tab2');
    await tab2.goto(fe.url);
    await waitLanding(tab2);
    await sleep(1500);
    assert.equal(await roomCodeShown(tab2), null, 'fresh tab must show the landing page');
    const C = await createRoomUI(tab2, 'Nisha');
    await page.reload();
    await waitRoom(page, A);
    await tab2.reload();
    await waitRoom(tab2, C);
    await tab2.close();
  });

  await t.test('7. same seat in two tabs: one banner, no reconnect ping-pong, "Use this tab" takes over', async () => {
    const tab3 = await ctx.newPage();
    trackErrors(tab3, errors, 'tab3');
    await tab3.goto(fe.url);
    await joinRoomUI(tab3, 'Nisha', A);
    await page.getByText(/opened in another tab/i).waitFor({ timeout: 10000 });
    // The baseline build reconnected the replaced tab every ~3 s and stole the seat back forever.
    let newSocketsOnReplacedTab = 0;
    page.on('websocket', () => { newSocketsOnReplacedTab++; });
    await sleep(9000);
    assert.equal(newSocketsOnReplacedTab, 0, `replaced tab opened ${newSocketsOnReplacedTab} new sockets in 9 s`);
    assert.equal(await tab3.getByText(/opened in another tab/i).count(), 0, 'the new tab kept the seat');
    await page.getByRole('button', { name: 'Use this tab' }).click();
    await tab3.getByText(/opened in another tab/i).waitFor({ timeout: 10000 });
    await page.getByText(/opened in another tab/i).waitFor({ state: 'detached', timeout: 10000 });
    await tab3.getByRole('button', { name: /Leave room here/i }).click();
    await waitLanding(tab3);
    await tab3.close();
  });

  await t.test('8. delayed room-creation response + cancel: nothing opens; the next create works', async () => {
    await leaveUI(page);
    let release;
    await page.route('**/api/rooms', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise(r => { release = r; });
      await route.continue();
    });
    await page.getByRole('button', { name: /Create Private Room/i }).first().click();
    await page.locator('#display-name').fill('Nisha');
    await page.getByRole('button', { name: /Create & Enter/i }).click();
    await sleep(500);
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    release();
    await sleep(2500);
    assert.equal(await roomCodeShown(page), null, 'cancelled creation must not open a room');
    await page.unroute('**/api/rooms');
    const D = await createRoomUI(page, 'Nisha');
    assert.ok(D);
  });

  await t.test('9. WebSocket drop: reconnects to the same room without duplicating the participant', async () => {
    await leaveUI(page);
    await joinRoomUI(page, 'Nisha', A);
    const before = await page.getByTestId('claimed-count').innerText();
    fe.dropAllSockets();
    await page.getByTestId('nav-link-status').filter({ hasText: /Reconnecting/ }).first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.getByTestId('nav-link-status').filter({ hasText: /Connected/ }).first().waitFor({ timeout: 20000 });
    assert.equal(await roomCodeShown(page), A);
    assert.equal(await page.getByTestId('claimed-count').innerText(), before);
    await page.getByTestId('lobby-franchise-CSK').getByText('Your Franchise').waitFor();
  });

  await t.test('10. Worker restart (Durable Object storage persisted): clients reconnect to the same room', async () => {
    await worker.mf.dispose();
    fe.dropAllSockets();
    worker = await startWorker({ persistDir: persist });
    fe.setTarget(worker);
    await page.getByTestId('nav-link-status').filter({ hasText: /Connected/ }).first().waitFor({ timeout: 30000 });
    assert.equal(await roomCodeShown(page), A);
    await page.getByTestId('lobby-franchise-CSK').getByText('Your Franchise').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(shotsDir, '10-after-worker-restart.png') });
  });

  await t.test('11. sign out: leaves, forgets identity; rejoining is a new identity (old franchise stays with the old owner)', async () => {
    await signOutUI(page);
    assert.equal(await page.getByTestId('resume-card').count(), 0);
    await page.reload();
    await waitLanding(page);
    await sleep(1000);
    assert.equal(await roomCodeShown(page), null);
    await joinRoomUI(page, 'Nisha2', A);
    const csk = page.getByTestId('lobby-franchise-CSK');
    assert.equal(await csk.getByText('Your Franchise').count(), 0);
    assert.equal(await csk.getAttribute('data-owner'), 'Nisha');
  });

  await t.test('12. no uncaught page errors', async () => {
    const real = errors.filter(e => !/WebSocket connection to .* failed|ERR_CONNECTION|502|Failed to load resource/.test(e));
    assert.deepEqual(real, []);
  });
});
