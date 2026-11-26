// Reproduces the old-room restoration bug against the CURRENT build (run before/after the fix).
import { startWorker, startFrontend, launchChrome } from './harness.js';

const w = await startWorker();
const fe = await startFrontend(w);
const browser = await launchChrome();
const out = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createRoom(page, name) {
  const resP = page.waitForResponse(r => r.url().endsWith('/api/rooms') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /Create Private Room/i }).first().click();
  await page.getByPlaceholder(/Captain Cool/i).fill(name);
  await page.getByRole('button', { name: /Create & Enter/i }).click();
  const code = (await (await resP).json()).roomCode;
  await page.getByText(code).first().waitFor({ timeout: 15000 });
  return code;
}
const shownRoom = async (page, codes) => {
  const txt = await page.evaluate(() => document.body.innerText);
  return codes.filter(c => txt.includes(c));
};

try {
  // R1: two tabs in one browser profile
  const ctx = await browser.newContext();
  const t1 = await ctx.newPage(); await t1.goto(fe.url);
  const A = await createRoom(t1, 'TabOne');
  const t2 = await ctx.newPage(); await t2.goto(fe.url);
  await sleep(2500);
  out.R1_tab2_on_open_shows = await shownRoom(t2, [A]);
  out.R1_note = 'Tab 2 was opened fresh; expected landing page, not Room A';
  // R2: "leave" Room A by navigating to the site again -> can we reach the landing page?
  const ctx2 = await browser.newContext();
  const p = await ctx2.newPage(); await p.goto(fe.url);
  const A2 = await createRoom(p, 'Leaver');
  await p.goto(fe.url); await sleep(2500);
  out.R2_after_navigating_home_shows = await shownRoom(p, [A2]);
  out.R2_create_button_visible = await p.getByRole('button', { name: /Create Private Room/i }).count();
  out.R2_leave_controls_in_lobby = await p.getByRole('button', { name: /leave|exit/i }).count();
  // R3: tab ping-pong (same token, same room in two tabs)
  let replaced = 0;
  for (const pg of [t1, t2]) pg.on('websocket', ws => ws.on('framereceived', f => { if (String(f.payload).includes('SESSION_REPLACED')) replaced++; }));
  await sleep(12000);
  out.R3_session_replaced_frames_in_12s = replaced;
} catch (e) { out.error = e.message; }
console.log(JSON.stringify(out, null, 2));
await browser.close(); await fe.close(); await w.mf.dispose();
