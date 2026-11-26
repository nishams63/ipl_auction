// GENUINE 10-BROWSER UI END-TO-END SUITE
// Ten independent Chrome browser contexts (8 desktop, 2 mobile) drive the real React production
// build, connected to the real Worker + Durable Object (SQLite) running in local workerd.
// Every action goes through the DOM; the backend is only observed, never called directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker, startFrontend, launchChrome, trackErrors, distDir } from './harness.js';
import { sleep, waitRoom, createRoomUI, joinRoomUI, claimUI } from './ui.js';

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'playback_screenshots', 'ten-player');
const PLAYERS = [
  ['CSK', 'Host_CSK'], ['MI', 'Owner_MI'], ['RCB', 'Owner_RCB'], ['KKR', 'Owner_KKR'], ['SRH', 'Owner_SRH'],
  ['RR', 'Owner_RR'], ['DC', 'Owner_DC'], ['PBKS', 'Owner_PBKS'], ['GT', 'Owner_GT'], ['LSG', 'Owner_LSG']
];
const MOBILE = new Set(['GT', 'LSG']);

const stage = async (p) => {
  const el = p.getByTestId('stage-player-name');
  return { id: await el.getAttribute('data-player-id'), cat: await el.getAttribute('data-category'), set: await el.getAttribute('data-set'), os: (await el.getAttribute('data-overseas')) === '1' };
};
const countdown = async (p) => Number((await p.getByTestId('countdown').innerText()).trim());
const hammer = async (p) => p.getByTestId('hammer-status').getAttribute('data-hammer');
const highest = async (p) => (await p.getByTestId('highest-bid').innerText()).replace(/\s+/g, '');
const card = (p, id) => p.getByTestId(`franchise-card-${id}`);
const noHorizontalOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('Ten real browsers play an auction end-to-end through the React UI', { timeout: 900000 }, async (t) => {
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'build client/dist first');
  fs.mkdirSync(shots, { recursive: true });
  const worker = await startWorker();
  const fe = await startFrontend(worker);
  const browser = await launchChrome();
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const errors = [];
  const pages = {};
  const contexts = [];
  t.after(async () => {
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
    await browser.close().catch(() => {});
    await fe.close();
    await worker.mf.dispose().catch(() => {});
  });

  for (const [fid] of PLAYERS) {
    const ctx = await browser.newContext(MOBILE.has(fid)
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1366, height: 900 } });
    contexts.push(ctx);
    const page = await ctx.newPage();
    trackErrors(page, errors, fid);
    pages[fid] = page;
  }
  // Functions, not arrays: a page can be replaced (tab closed and reopened) mid-test
  const all = () => Object.values(pages);
  const desktop = () => PLAYERS.filter(([f]) => !MOBILE.has(f)).map(([f]) => pages[f]);
  const host = pages.CSK;
  let code;

  await t.test('1-5. ten participants open the app, one creates, nine join, all claim different franchises, lobby in sync', async () => {
    await Promise.all(all().map(p => p.goto(fe.url)));
    for (const p of [pages.GT, pages.LSG]) assert.ok(await noHorizontalOverflow(p), 'landing: no horizontal overflow on mobile');
    code = await createRoomUI(host, 'Host_CSK');
    await Promise.all(PLAYERS.slice(1).map(([, name], i) => joinRoomUI(pages[PLAYERS[i + 1][0]], name, code)));
    for (const [fid, page] of Object.entries(pages)) await claimUI(page, fid);
    await Promise.all(all().map(p => p.getByTestId('claimed-count').filter({ hasText: /^10 \/ 10/ }).waitFor({ timeout: 15000 })));
    for (const [fid] of PLAYERS) {
      const owners = await Promise.all(all().map(p => p.getByTestId(`lobby-franchise-${fid}`).getAttribute('data-owner')));
      assert.equal(new Set(owners).size, 1, `${fid} owner identical on every screen`);
    }
    for (const p of [pages.GT, pages.LSG]) assert.ok(await noHorizontalOverflow(p), 'lobby: no horizontal overflow on mobile');
    await host.screenshot({ path: path.join(shots, '01-lobby-10-of-10.png'), fullPage: false });
    await pages.LSG.screenshot({ path: path.join(shots, '01-lobby-mobile.png') });
  });

  await t.test('6-7. host starts; all ten screens show the same current player', async () => {
    await host.getByTestId('start-auction').click();
    await Promise.all(all().map(p => p.getByTestId('stage-player-name').waitFor({ timeout: 20000 })));
    const ids = await Promise.all(all().map(async p => (await stage(p)).id));
    assert.equal(new Set(ids).size, 1, `players on screens: ${[...new Set(ids)]}`);
    // Every screen shows the server's clock (within 1 s of each other and of the authoritative deadline)
    const cds = await Promise.all(all().map(countdown));
    const srv = await host.evaluate(async (c) => { const r = await (await fetch(`/api/rooms/${c}`)).json(); return Math.ceil((r.currentLot.deadlineEpochMs - Date.now()) / 1000); }, code);
    assert.ok(Math.max(...cds) - Math.min(...cds) <= 1, `screens disagree: ${cds}`);
    for (const c of cds) assert.ok(Math.abs(c - srv) <= 1, `screen ${c}s vs server ${srv}s`);
    const firstLot = await host.evaluate(async (c) => (await (await fetch(`/api/rooms/${c}`)).json()).currentLot.timerDuration, code);
    assert.equal(firstLot, 15, '15-second lot timer');
    await host.screenshot({ path: path.join(shots, '02-live-auction-desktop.png') });
    await pages.GT.screenshot({ path: path.join(shots, '02-live-auction-mobile.png') });
    for (const p of [pages.GT, pages.LSG]) {
      assert.ok(await noHorizontalOverflow(p), 'live auction: no horizontal overflow on mobile');
      // The sticky bid bar is on screen without scrolling, at least 44 px tall (touch target)
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      const bid = p.getByTestId('mobile-bid-button');
      const box = await bid.boundingBox();
      const vp = p.viewportSize();
      assert.ok(box && box.y >= 0 && box.y + box.height <= vp.height && box.height >= 44, `mobile bid button visible and tappable: ${JSON.stringify(box)}`);
      await p.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await p.getByTestId('countdown').isVisible(), 'countdown visible on mobile');
      assert.ok(await p.getByTestId('highest-bid').isVisible(), 'current bid visible on mobile');
    }
  });

  await t.test('8-10. simultaneous bids: exactly one accepted; every screen shows the same leader and amount', async () => {
    const bidders = [pages.MI, pages.RCB, pages.KKR];
    // Fire all three clicks at the same wall-clock instant from inside each browser
    const at = Date.now() + 800;
    await Promise.all(bidders.map(p => p.evaluate((when) => new Promise(res => setTimeout(() => {
      document.querySelector('[data-testid="bid-button"]').click(); res();
    }, Math.max(0, when - Date.now()))), at)));
    await sleep(1200);
    const acc = await Promise.all(bidders.map(p => p.getByTestId('bid-accepted').count()));
    const rej = await Promise.all(bidders.map(p => p.getByTestId('bid-error').count()));
    const errs = await Promise.all(bidders.map(async p => (await p.getByTestId('bid-error').count()) ? p.getByTestId('bid-error').innerText() : ''));
    const accepted = acc.reduce((a, b) => a + b, 0);
    const rejected = rej.reduce((a, b) => a + b, 0);
    assert.equal(accepted, 1, `exactly one bid accepted (accepted=${acc} rejected=${rej} ${errs})`);
    assert.equal(rejected, 2, `the other two were rejected with a visible reason (accepted=${acc} rejected=${rej} ${errs})`);
    const amounts = await Promise.all(all().map(highest));
    assert.equal(new Set(amounts).size, 1, `highest bid differs across screens: ${amounts}`);
    const leaders = await Promise.all(desktop().map(async p => {
      for (const [fid] of PLAYERS) if ((await card(p, fid).getAttribute('data-bid-state')) === 'leading') return fid;
      return null;
    }));
    assert.equal(new Set(leaders).size, 1);
    assert.ok(['MI', 'RCB', 'KKR'].includes(leaders[0]));
    // the leader cannot bid again (rule shown, server would refuse)
    const leaderPage = pages[leaders[0]];
    assert.equal(await leaderPage.getByTestId('bid-button').isDisabled(), true);
    assert.match(await leaderPage.getByTestId('bid-blocked-reason').innerText(), /already holds the highest bid/i);
    await host.screenshot({ path: path.join(shots, '03-after-simultaneous-bids.png') });
  });

  let soldTo, soldPrice, purseBefore;
  await t.test('14. hammer: SOLD on every screen; winner purse debited identically everywhere', async () => {
    const leader = (await Promise.all(PLAYERS.map(async ([f]) => [f, await card(host, f).getAttribute('data-bid-state')]))).find(([, s]) => s === 'leading')[0];
    soldTo = leader;
    soldPrice = Number((await highest(host)).replace(/[^\d.]/g, ''));
    purseBefore = 120;
    await host.getByTestId('host-advance').click();
    await Promise.all(all().map(p => p.getByTestId('hammer-overlay').waitFor({ timeout: 10000 }).catch(() => {})));
    await Promise.all(desktop().map(p => p.getByTestId('hammer-status').and(p.locator('[data-hammer="sold"]')).waitFor({ timeout: 10000 }).catch(() => {})));
    const purses = await Promise.all(desktop().map(async p => (await card(p, soldTo).innerText()).match(/₹([\d.]+) Cr/)[1]));
    assert.equal(new Set(purses).size, 1, `purse differs across screens: ${purses}`);
    assert.equal(Math.round(Number(purses[0]) * 100), Math.round((purseBefore - soldPrice) * 100), 'purse = 120 − price (integer lakhs)');
  });

  await t.test('11-12. a valid bid resets every screen to 15 s; time runs down when nobody bids', async () => {
    await Promise.all(all().map(p => p.getByTestId('hammer-status').and(p.locator('[data-hammer="open"]')).waitFor({ timeout: 15000 })));
    await sleep(3500);
    const before = await countdown(pages.SRH);
    assert.ok(before <= 12, `countdown ran down to ${before}`);
    await pages.GT.getByTestId('mobile-bid-button').click(); // a phone user bids from the sticky bar
    await pages.GT.waitForFunction(() => /GT/.test(document.querySelector('[data-testid="mobile-bid-bar"]')?.textContent || ''), null, { timeout: 5000 });
    await sleep(600);
    const after = await Promise.all(all().map(countdown));
    for (const c of after) assert.ok(c >= 13, `timer not reset on a screen: ${after}`);
    // leader's own button is disabled and nobody else bid: clock keeps falling
    const c1 = await countdown(pages.DC); await sleep(2100); const c2 = await countdown(pages.DC);
    assert.ok(c2 <= c1 - 1, `clock should keep running without valid bids (${c1}→${c2})`);
  });

  await t.test('19. pause freezes every screen and disables bidding; resume continues', async () => {
    await host.getByTestId('host-pause').click();
    await Promise.all(all().map(p => p.getByTestId('hammer-status').and(p.locator('[data-hammer="paused"]')).waitFor({ timeout: 10000 })));
    const a = await countdown(pages.PBKS); await sleep(2000); const b = await countdown(pages.PBKS);
    assert.equal(a, b, 'clock frozen while paused');
    assert.equal(await pages.RR.getByTestId('bid-button').isDisabled(), true);
    assert.match(await pages.RR.getByTestId('bid-blocked-reason').innerText(), /paused/i);
    await host.screenshot({ path: path.join(shots, '04-paused.png') });
    await host.getByTestId('host-pause').click();
    await Promise.all(all().map(p => p.getByTestId('hammer-status').and(p.locator('[data-hammer="paused"]')).waitFor({ state: 'detached', timeout: 10000 })));
  });

  await t.test('15. refresh mid-auction restores the same room, lot and franchise', async () => {
    const before = await stage(pages.MI);
    await pages.MI.reload();
    await waitRoom(pages.MI, code);
    await pages.MI.getByTestId('stage-player-name').waitFor();
    assert.equal((await stage(pages.MI)).id, before.id);
    assert.match(await card(pages.MI, 'MI').innerText(), /YOU/);
  });

  await t.test('17-18. closing a tab and coming back: explicit Rejoin returns to the same franchise without duplicates', async () => {
    const ctx = pages.KKR.context();
    await pages.KKR.close();
    const p = await ctx.newPage();
    trackErrors(p, errors, 'KKR-2');
    pages.KKR = p;
    await p.goto(fe.url);
    await p.getByTestId('resume-card').waitFor({ timeout: 10000 });
    await sleep(800);
    assert.equal(await p.getByTestId('stage-player-name').count(), 0, 'a new tab does not auto-enter the room');
    await p.getByRole('button', { name: new RegExp(`Rejoin ${code}`) }).click();
    await p.getByRole('button', { name: /Enter Lobby/i }).click();
    await waitRoom(p, code);
    await p.getByTestId('stage-player-name').waitFor();
    assert.match(await card(p, 'KKR').innerText(), /YOU/);
    const owners = await Promise.all(desktop().filter(x => x !== p).map(x => card(x, 'KKR').innerText()));
    assert.ok(owners.every(t => /Owner_KKR/.test(t)), 'same owner, no duplicate participant');
  });

  await t.test('20. Skip Set moves every screen to the next set', async () => {
    const before = await stage(host);
    await host.getByTestId('host-skip-set').click();
    await host.getByRole('button', { name: /Confirm Skip/ }).click();
    await Promise.all(all().map(p => p.waitForFunction((set) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.set !== set, before.set, { timeout: 15000 })));
    const sets = await Promise.all(all().map(async p => (await stage(p)).set));
    assert.equal(new Set(sets).size, 1);
    assert.notEqual(sets[0], before.set);
  });

  await t.test('13a. overseas cap in the UI: MI buys 8 overseas players; the 9th is blocked with a clear reason', async () => {
    const mi = pages.MI;
    const osOf = async () => Number((await card(host, 'MI').innerText()).match(/(\d+)\/8 OS/)[1]);
    let guard = 0;
    while (guard++ < 80 && (await osOf()) < 8) {
      await host.getByTestId('hammer-status').and(host.locator('[data-hammer="open"], [data-hammer="once"], [data-hammer="twice"]')).waitFor({ timeout: 20000 });
      const s = await stage(host);
      if (s.os && !(await mi.getByTestId('bid-button').isDisabled())) {
        await mi.getByTestId('bid-button').click();
        await mi.getByTestId('bid-accepted').waitFor({ timeout: 5000 });
      }
      await host.getByTestId('host-advance').click(); // hammer (SOLD to MI or UNSOLD)
      await host.waitForFunction((id) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.playerId !== id, s.id, { timeout: 20000 });
    }
    assert.equal(await osOf(), 8);
    guard = 0;
    while (guard++ < 60) {
      await host.getByTestId('hammer-status').and(host.locator('[data-hammer="open"], [data-hammer="once"], [data-hammer="twice"]')).waitFor({ timeout: 20000 });
      const s = await stage(host);
      if (s.os) break;
      await host.getByTestId('host-advance').click();
      await host.waitForFunction((id) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.playerId !== id, s.id, { timeout: 20000 });
    }
    assert.equal((await stage(mi)).os, true, 'an overseas player is on the stage');
    assert.equal(await mi.getByTestId('bid-button').isDisabled(), true);
    assert.match(await mi.getByTestId('bid-blocked-reason').innerText(), /Overseas player limit reached/i);
    assert.equal(await card(host, 'MI').getAttribute('data-bid-state'), 'blocked', 'every screen shows MI cannot bid');
    await mi.screenshot({ path: path.join(shots, '05-overseas-cap-blocked.png') });
    await host.getByTestId('host-advance').click();
  });

  await t.test('13b. host builds a squad through the UI (base-price buys, skipping sets until a keeper)', async () => {
    let guard = 0;
    let bought = 0;
    let osBought = 0;
    let haveWK = false;
    while (guard++ < 80 && !(bought >= 11 && haveWK)) {
      await host.getByTestId('hammer-status').and(host.locator('[data-hammer="open"], [data-hammer="once"], [data-hammer="twice"]')).waitFor({ timeout: 20000 });
      const s = await stage(host);
      const keeperOnly = !haveWK && bought >= 10;
      const want = keeperOnly ? s.cat === 'WK' : (s.cat === 'WK' && !haveWK) || (bought < 11 && (!s.os || osBought < 4));
      if (keeperOnly && s.cat !== 'WK') {
        await host.getByTestId('host-skip-set').click();
        await host.getByRole('button', { name: /Confirm Skip/ }).click();
        await host.waitForFunction((id) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.playerId !== id, s.id, { timeout: 15000 });
        continue;
      }
      if (want && !(await host.getByTestId('bid-button').isDisabled())) {
        await host.getByTestId('bid-button').click();
        await host.getByTestId('bid-accepted').waitFor({ timeout: 5000 });
        bought += 1;
        if (s.os) osBought += 1;
        if (s.cat === 'WK') haveWK = true;
      }
      await host.getByTestId('host-advance').click();
      await host.waitForFunction((id) => document.querySelector('[data-testid="stage-player-name"]')?.dataset.playerId !== id, s.id, { timeout: 20000 });
    }
    assert.ok(bought >= 11 && haveWK, `bought ${bought}, keeper ${haveWK}`);
    const sq = await card(pages.SRH, 'CSK').innerText();
    assert.match(sq, new RegExp(`${bought}/25 sq`));
  });

  await t.test('21. Playing XI: invalid XI cannot be saved; a valid XI is saved by the server', async () => {
    await host.getByRole('button', { name: 'Squads' }).click();
    await host.getByTestId('tab-playing-xi').click();
    await host.getByTestId('xi-save').waitFor();
    assert.equal(await host.getByTestId('xi-save').isDisabled(), true, 'empty XI cannot be saved');
    // Pick a keeper first, then fill to 11 with at most 4 overseas
    const room = await host.evaluate(async (c) => (await (await fetch(`/api/rooms/${c}`)).json()), code);
    const squad = room.franchises.CSK.squad;
    const wk = squad.find(p => p.category === 'WK');
    const others = squad.filter(p => p.id !== wk.id);
    const pick = [wk];
    let os = wk.isOverseas ? 1 : 0;
    for (const p of others) { if (pick.length === 11) break; if (p.isOverseas && os >= 4) continue; pick.push(p); if (p.isOverseas) os++; }
    assert.equal(pick.length, 11);
    for (const p of pick) await host.getByTestId(`xi-add-${p.id}`).click();
    await host.getByTestId(`xi-captain-${pick[1].id}`).click();
    await host.getByTestId(`xi-vc-${pick[2].id}`).click();
    await host.getByTestId('xi-save').click();
    await host.getByTestId('xi-saved').waitFor({ timeout: 10000 });
    const after = await host.evaluate(async (c) => (await (await fetch(`/api/rooms/${c}`)).json()), code);
    assert.equal(after.franchises.CSK.playingXI.length, 11);
    assert.equal(after.franchises.CSK.captainId, pick[1].id);
    await host.screenshot({ path: path.join(shots, '05-playing-xi-saved.png') });
    await host.getByTestId('squad-close').click();
  });

  await t.test('22-24. host concludes; all ten screens show the same results; Mastermind ranks 1-10 uniquely with one winner', async () => {
    await host.getByTestId('host-finish').click();
    await host.getByRole('dialog').getByRole('button', { name: /Conclude auction/ }).click();
    await Promise.all(all().map(p => p.getByTestId('results-winner').waitFor({ timeout: 30000 })));
    const winners = await Promise.all(all().map(p => p.getByTestId('results-winner').getAttribute('data-franchise')));
    assert.equal(new Set(winners).size, 1, `winners: ${winners}`);
    await host.getByRole('tab', { name: /Official Rankings/ }).click();
    const rows = host.getByTestId('ranking-row');
    await rows.first().waitFor();
    const ranks = await rows.evaluateAll(els => els.map(e => [Number(e.dataset.rank), e.dataset.franchise]));
    assert.equal(ranks.length, 10);
    assert.deepEqual(ranks.map(r => r[0]).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(new Set(ranks.map(r => r[1])).size, 10);
    assert.equal(ranks.find(r => r[0] === 1)[1], winners[0]);
    for (const p of [pages.GT, pages.LSG]) assert.ok(await noHorizontalOverflow(p), 'results: no horizontal overflow on mobile');
    await host.screenshot({ path: path.join(shots, '06-results-rankings.png') });
    await pages.GT.screenshot({ path: path.join(shots, '06-results-mobile.png') });
  });

  await t.test('no uncaught errors in any of the ten browsers', async () => {
    const real = errors.filter(e => !/Failed to load resource|ERR_|tse\d\.mm\.bing|net::/.test(e));
    assert.deepEqual(real, []);
  });
});
