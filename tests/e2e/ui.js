// UI helpers for the real-browser E2E suites (all interactions go through the React DOM).
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitLanding(page, timeout = 15000) {
  await page.getByRole('button', { name: /Create Private Room/i }).first().waitFor({ timeout });
}

export async function roomCodeShown(page) {
  const el = page.getByTestId('nav-room-code');
  if (!(await el.count())) return null;
  const txt = (await el.first().innerText()).replace(/Room/i, '').trim();
  return txt.match(/[A-Z0-9]{4,12}/)?.[0] || null;
}

export async function waitRoom(page, code, timeout = 20000) {
  await page.getByTestId('nav-room-code').filter({ hasText: code }).first().waitFor({ timeout });
}

export async function createRoomUI(page, name) {
  await waitLanding(page);
  await page.getByRole('button', { name: /Create Private Room/i }).first().click();
  const nameInput = page.locator('#display-name');
  await nameInput.fill(name);
  const resP = page.waitForResponse(r => r.url().endsWith('/api/rooms') && r.request().method() === 'POST', { timeout: 20000 });
  await page.getByRole('button', { name: /Create & Enter/i }).click();
  const res = await resP;
  const code = (await res.json()).roomCode;
  await waitRoom(page, code);
  return code;
}

export async function joinRoomUI(page, name, code) {
  await waitLanding(page);
  await page.getByRole('button', { name: /Join with Room Code/i }).first().click();
  await page.locator('#display-name').fill(name);
  await page.locator('#room-code').fill(code);
  await page.getByRole('button', { name: /Enter Lobby/i }).click();
  await waitRoom(page, code);
}

export async function leaveUI(page) {
  await page.getByTestId('account-menu').click();
  await page.getByTestId('leave-room').click();
  await page.getByRole('dialog').getByRole('button', { name: /^Leave room$/ }).click();
  await waitLanding(page);
}

export async function signOutUI(page) {
  await page.getByTestId('account-menu').click();
  await page.getByTestId('sign-out').click();
  await page.getByRole('dialog').getByRole('button', { name: /^Sign out$/ }).click();
  await waitLanding(page);
}

export async function claimUI(page, franchiseId) {
  await page.getByTestId(`claim-${franchiseId}`).click();
  await page.getByTestId(`lobby-franchise-${franchiseId}`).getByText('Your Franchise').waitFor({ timeout: 10000 });
}

// Records every room code that appears in the navbar while `fn` runs
export async function watchRoomCodes(page, fn) {
  await page.evaluate(() => {
    window.__seenCodes = [];
    const rec = () => {
      const el = document.querySelector('[data-testid="nav-room-code"]');
      const m = el?.textContent?.match(/[A-Z0-9]{6}/);
      if (m && window.__seenCodes.at(-1) !== m[0]) window.__seenCodes.push(m[0]);
    };
    window.__codeObs?.disconnect();
    window.__codeObs = new MutationObserver(rec);
    window.__codeObs.observe(document.body, { subtree: true, childList: true, characterData: true });
    rec();
  });
  const result = await fn();
  const seen = await page.evaluate(() => window.__seenCodes);
  return { result, seen };
}
