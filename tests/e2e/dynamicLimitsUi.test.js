// REAL-BROWSER E2E verification for Dynamic Squad Size & Overseas Player Limit.
// Real React production build + real Worker / Durable Object (SQLite) + headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorker, startFrontend, launchChrome, trackErrors, distDir } from './harness.js';
import { waitLanding, waitRoom, joinRoomUI, claimUI } from './ui.js';

test('Dynamic squad size (15) and overseas limit (5) work end-to-end across Create Room, Lobby, Live Bidding, Dashboard, Reload & Results', { timeout: 300000 }, async (t) => {
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'build client/dist first');
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dyn-limits-'));
  const worker = await startWorker({ persistDir });
  const fe = await startFrontend(worker);
  const browser = await launchChrome();
  if (!browser) {
    await fe.close();
    await worker.mf.dispose();
    t.skip('Chrome not found');
    return;
  }

  const errors = [];
  t.after(async () => {
    await browser.close().catch(() => {});
    await fe.close();
    await worker.mf.dispose().catch(() => {});
    fs.rmSync(persistDir, { recursive: true, force: true });
  });

  const ctxHost = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const ctxGuest = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const host = await ctxHost.newPage();
  const guest = await ctxGuest.newPage();
  trackErrors(host, errors, 'host');
  trackErrors(guest, errors, 'guest');

  // 1. Host creates room selecting Squad Size = 15 and Overseas Limit = 5
  await host.goto(fe.url, { waitUntil: 'domcontentloaded' });
  await waitLanding(host);
  await host.getByRole('button', { name: /Create Private Room/i }).first().click();
  await host.locator('#display-name').fill('Host_CSK');
  await host.getByTestId('create-max-squad-size').selectOption('15');
  await host.getByTestId('create-max-overseas').selectOption('5');
  const createResP = host.waitForResponse(r => r.url().endsWith('/api/rooms') && r.request().method() === 'POST', { timeout: 20000 });
  await host.getByRole('button', { name: /Create & Enter/i }).click();
  const createData = await (await createResP).json();
  assert.equal(createData.room.max_squad_size, 15);
  assert.equal(createData.room.max_overseas_players, 5);
  const code = createData.roomCode;
  await waitRoom(host, code);

  // 2. Guest joins and both participants see chosen settings in the lobby before start
  await guest.goto(fe.url, { waitUntil: 'domcontentloaded' });
  await joinRoomUI(guest, 'Guest_MI', code);
  await guest.getByTestId('lobby-rules-summary').filter({ hasText: 'Max Squad: 15 · Max Overseas: 5' }).waitFor({ timeout: 10000 });
  await host.getByTestId('lobby-rules-summary').filter({ hasText: 'Max Squad: 15 · Max Overseas: 5' }).waitFor({ timeout: 10000 });

  await claimUI(host, 'CSK');
  await claimUI(guest, 'MI');

  // 3. Start auction
  await host.getByTestId('start-auction').click();
  await Promise.all([
    host.getByTestId('stage-player-name').waitFor({ timeout: 20000 }),
    guest.getByTestId('stage-player-name').waitFor({ timeout: 20000 })
  ]);

  const stageInfo = async (p) => {
    const el = p.getByTestId('stage-player-name');
    return {
      id: await el.getAttribute('data-player-id'),
      cat: await el.getAttribute('data-category'),
      os: (await el.getAttribute('data-overseas')) === '1'
    };
  };

  // CSK buys 5 overseas + 10 Indian (including at least 1 WK), MI buys 2 Indian players concurrently
  let cskCount = 0;
  let cskOs = 0;
  let cskWk = false;
  let miCount = 0;
  let verifiedOsBlock = false;
  let guard = 0;

  while (guard++ < 150 && (cskCount < 15 || miCount < 2 || !verifiedOsBlock)) {
    await host.getByTestId('hammer-status').and(host.locator('[data-hammer="open"], [data-hammer="once"], [data-hammer="twice"]')).waitFor({ timeout: 20000 });
    const s = await stageInfo(host);

    if (cskOs === 5 && s.os && !verifiedOsBlock) {
      // CSK hit 5/5 overseas -> bid button disabled with "Overseas player limit reached!" while MI can still bid
      assert.equal(await host.getByTestId('bid-button').isDisabled(), true);
      assert.match(await host.getByTestId('bid-blocked-reason').innerText(), /Overseas player limit reached!/);
      verifiedOsBlock = true;
    } else if (cskCount < 15) {
      const needWk = !cskWk && cskCount === 14;
      const canTarget = (!needWk || s.cat === 'WK') && (cskOs < 5 || !s.os);
      if (canTarget && !(await host.getByTestId('bid-button').isDisabled())) {
        await host.getByTestId('bid-button').click();
        await host.getByTestId('bid-accepted').waitFor({ timeout: 5000 });
        cskCount += 1;
        if (s.os) cskOs += 1;
        if (s.cat === 'WK') cskWk = true;
      } else if (miCount < 2 && !s.os && !(await guest.getByTestId('bid-button').isDisabled())) {
        await guest.getByTestId('bid-button').click();
        await guest.getByTestId('bid-accepted').waitFor({ timeout: 5000 });
        miCount += 1;
      }
    } else if (miCount < 2 && !(await guest.getByTestId('bid-button').isDisabled())) {
      await guest.getByTestId('bid-button').click();
      await guest.getByTestId('bid-accepted').waitFor({ timeout: 5000 });
      miCount += 1;
    }

    await host.getByTestId('host-advance').click(); // hammer
    await host.waitForFunction((id) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.playerId !== id, s.id, { timeout: 20000 });
  }

  assert.equal(cskCount, 15, `CSK should reach 15 players, got ${cskCount}`);
  assert.equal(cskOs, 5, `CSK should have 5 overseas, got ${cskOs}`);
  assert.equal(verifiedOsBlock, true, 'Must verify overseas limit reached block');

  // 4. Verify CSK is now blocked on EVERY player with "Squad limit reached!"
  await host.getByTestId('hammer-status').and(host.locator('[data-hammer="open"], [data-hammer="once"], [data-hammer="twice"]')).waitFor({ timeout: 20000 });
  assert.equal(await host.getByTestId('bid-button').isDisabled(), true);
  assert.match(await host.getByTestId('bid-blocked-reason').innerText(), /Squad limit reached!/);

  // 5. Verify Team Dashboard displays X / 15, Y / 5, Remaining Indian/Overseas/Total slots
  await host.getByRole('button', { name: 'Squads' }).click();
  await host.getByTestId('dashboard-slots-CSK').filter({ hasText: '0 Total' }).waitFor({ timeout: 10000 });
  await host.getByTestId('dashboard-slots-CSK').filter({ hasText: 'IND 0 · OS 0' }).waitFor({ timeout: 10000 });
  await host.getByTestId('dashboard-slots-MI').filter({ hasText: `${15 - miCount} Total` }).waitFor({ timeout: 10000 });
  await host.getByRole('button', { name: 'Individual Squad' }).click();
  await host.getByTestId('individual-slot-breakdown').filter({ hasText: '15 / 15' }).waitFor({ timeout: 10000 });
  await host.getByTestId('individual-slot-breakdown').filter({ hasText: '5 / 5' }).waitFor({ timeout: 10000 });
  await host.getByTestId('individual-slot-breakdown').filter({ hasText: 'Squad limit reached!' }).waitFor({ timeout: 10000 });
  await host.getByTestId('individual-slot-breakdown').filter({ hasText: 'Overseas player limit reached!' }).waitFor({ timeout: 10000 });

  // Close Dashboard modal and test reload persistence
  await host.locator('button[aria-label="Close modal"], button:has(svg.lucide-x)').first().click();
  await host.reload({ waitUntil: 'domcontentloaded' });
  await waitRoom(host, code);
  await host.getByTestId('bid-blocked-reason').filter({ hasText: 'Squad limit reached!' }).waitFor({ timeout: 15000 });

  // 6. Conclude auction and verify Final Results reflect custom 15 / 5 limits cleanly
  await host.getByTestId('host-finish').click();
  await host.getByRole('dialog').getByRole('button', { name: /Conclude auction/i }).click();
  await host.getByTestId('results-winner').waitFor({ timeout: 15000 });
  await host.getByRole('tab', { name: /Rankings/i }).click();
  await host.locator('[data-testid="ranking-row"][data-franchise="CSK"]').filter({ hasText: '15/15 players · 5/5 overseas' }).waitFor({ timeout: 10000 });

  const realErrors = errors.filter(e => !/Failed to load resource: net::ERR_NAME_NOT_RESOLVED/.test(e));
  assert.equal(realErrors.length, 0, `Unexpected browser errors: ${realErrors.join('; ')}`);
});
