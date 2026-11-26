// Full Real Browser Render & Playback Simulation
// Runs real Vite client bundle + workerd Cloudflare Worker + Headless Google Chrome
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Miniflare } from 'miniflare';
import esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { findChrome } from './e2e/harness.js';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, '..', 'client', 'dist');
const screenshotDir = path.join(__dirname, '..', 'playback_screenshots');

if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

async function runRenderPlayback() {
  console.log('🎬 Starting Full Browser Render & Playback Verification...\n');

  // 1. Bundle Worker for workerd
  const build = esbuild.buildSync({
    entryPoints: ['cloudflare/src/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*']
  });

  // 2. Start Miniflare with DO SQLite
  const mf = new Miniflare({
    modules: true,
    script: build.outputFiles[0].text,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      AUCTION_ROOMS: {
        className: 'AuctionRoomDO',
        useSQLite: true
      }
    }
  });

  const mfOrigin = (await mf.ready).origin;
  const mfPort = Number(new URL(mfOrigin).port);
  console.log(`[workerd] Edge runtime listening on ${mfOrigin}`);

  // 3. Start unified Express server serving React client/dist and proxying /api & WebSockets
  const app = express();
  app.all('/api/*', async (req, res) => {
    try {
      const targetUrl = mfOrigin + req.originalUrl;
      const init = {
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:' + mfPort }
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        init.body = Buffer.concat(chunks);
      }
      const workerRes = await fetch(targetUrl, init);
      res.status(workerRes.status);
      for (const [k, v] of workerRes.headers) {
        if (k.toLowerCase() !== 'transfer-encoding' && k.toLowerCase() !== 'content-length' && k.toLowerCase() !== 'content-encoding') {
          res.setHeader(k, v);
        }
      }
      const buf = Buffer.from(await workerRes.arrayBuffer());
      res.send(buf);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    const proxySocket = net.connect(mfPort, '127.0.0.1', () => {
      proxySocket.write(
        req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n' +
        Object.entries(req.headers).map(([k, v]) => k + ': ' + v).join('\r\n') +
        '\r\n\r\n'
      );
      if (head && head.length) proxySocket.write(head);
      socket.pipe(proxySocket).pipe(socket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const appPort = server.address().port;
  const appUrl = `http://127.0.0.1:${appPort}`;
  console.log(`[Unified Server] App & API live on ${appUrl}`);

  // 4. Launch real Google Chrome via playwright-core
  const chromePath = findChrome();
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });

  try {
    // -------------------------------------------------------------
    // PLAYBACK SCENE 1: Landing Page & Hero Section
    // -------------------------------------------------------------
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const hostPage = await hostContext.newPage();
    hostPage.on('dialog', dialog => {
      console.log(`[Host Dialog] Accepting browser dialog: "${dialog.message()}"`);
      dialog.accept();
    });
    hostPage.on('console', msg => console.log('[Host Console]', msg.type(), msg.text()));
    hostPage.on('pageerror', err => console.log('[Host Page Error]', err.message));
    await hostPage.goto(appUrl, { waitUntil: 'networkidle' });

    console.log('📸 Rendering Playback Scene 1: Landing Page...');
    await hostPage.screenshot({ path: path.join(screenshotDir, '01_landing_page.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 2: Host Creates Room
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 2: Create Room Modal...');
    await hostPage.click('button:has-text("Create Private Room")');
    await hostPage.waitForSelector('input[placeholder*="Captain Cool" i], input[type="text"]');
    await hostPage.screenshot({ path: path.join(screenshotDir, '02_create_modal.png') });

    await hostPage.fill('input[placeholder*="Captain Cool" i], input[type="text"]', 'MS Dhoni');
    await hostPage.click('button:has-text("Create & Enter")');

    // Wait for Lobby View
    await hostPage.waitForSelector('text=LOBBY', { timeout: 10000 });
    console.log('📸 Rendering Playback Scene 3: Lobby Created...');
    await hostPage.screenshot({ path: path.join(screenshotDir, '03_lobby_host.png') });

    // Extract Room Code
    const pageText = await hostPage.textContent('body');
    const codeMatch = pageText.match(/ROOM CODE\s*([A-Z0-9]{6})/i) || pageText.match(/\b([A-Z0-9]{6})\b/);
    const roomCode = codeMatch ? (codeMatch[1] || codeMatch[0]) : null;
    console.log(`[Playback] Extracted Room Code: ${roomCode}`);
    assert.ok(roomCode);

    // Host Claims CSK
    console.log('📸 Rendering Playback Scene 4: Host Claims CSK...');
    const cskClaimBtn = hostPage.locator('button:has-text("Claim Franchise")').first();
    await cskClaimBtn.click();
    await hostPage.waitForTimeout(400);
    await hostPage.screenshot({ path: path.join(screenshotDir, '04_csk_claimed.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 3: Player 2 (Virat Kohli) Joins via Second Page
    // -------------------------------------------------------------
    const p2Context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2Page = await p2Context.newPage();
    p2Page.on('console', msg => console.log('[P2 Console]', msg.type(), msg.text()));
    p2Page.on('pageerror', err => console.log('[P2 Page Error]', err.message));
    await p2Page.goto(appUrl, { waitUntil: 'networkidle' });

    console.log('📸 Rendering Playback Scene 5: Player 2 Joins Room...');
    await p2Page.click('button:has-text("Join with Room Code")');
    await p2Page.waitForSelector('input[placeholder*="Captain Cool" i], input[type="text"]');
    await p2Page.fill('input[placeholder*="Captain Cool" i], input[type="text"]', 'Virat Kohli');
    await p2Page.fill('input[placeholder*="7XKP9Q" i], input[maxlength="6"]', roomCode);
    await p2Page.click('button:has-text("Enter Lobby")');

    await p2Page.waitForSelector('text=LOBBY', { timeout: 10000 });

    // Player 2 Claims RCB (index 2)
    const rcbClaimBtn = p2Page.locator('button:has-text("Claim Franchise")').nth(2);
    await rcbClaimBtn.click();
    await p2Page.waitForTimeout(400);
    console.log('📸 Rendering Playback Scene 6: Both Franchises Claimed...');
    await p2Page.screenshot({ path: path.join(screenshotDir, '05_both_claimed_in_lobby.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 4: Host Starts Auction & Lot 1 Countdown
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 7: Host Starts Auction...');
    const startBtn = await hostPage.waitForSelector('button:has-text("Start Live Auction Now")');
    await startBtn.click();

    // Wait for Live Auction View on both pages
    await hostPage.waitForSelector('text=TIME LEFT', { timeout: 10000 });
    await p2Page.waitForSelector('text=TIME LEFT', { timeout: 10000 });
    await hostPage.waitForTimeout(400);

    console.log('📸 Rendering Playback Scene 8: Live Auction Block & 15s Countdown...');
    await hostPage.screenshot({ path: path.join(screenshotDir, '06_live_auction_lot1.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 5: CSK Places Bid
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 9: CSK Places 2.00 Cr Opening Bid...');
    const cskBidBtn = await hostPage.waitForSelector('[data-testid="bid-button"]');
    await cskBidBtn.click();
    await hostPage.waitForTimeout(300);
    await hostPage.screenshot({ path: path.join(screenshotDir, '07_csk_bid_accepted.png') });

    // Verify bid reflected on Player 2 screen
    await p2Page.waitForSelector('text=₹2.00 Cr', { timeout: 5000 });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 6: RCB Outbids at 2.25 Cr
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 10: RCB Places 2.25 Cr Counter-Bid...');
    const rcbBidBtn = await p2Page.waitForSelector('[data-testid="bid-button"]');
    await rcbBidBtn.click();
    await p2Page.waitForTimeout(300);
    await p2Page.screenshot({ path: path.join(screenshotDir, '08_rcb_bid_accepted.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 7: Hammer Falls & Cinematic SOLD Card Renders
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 11: Host Advances Lot -> Hammer Falls SOLD...');
    const advanceBtn = await hostPage.waitForSelector('[data-testid="host-advance"]');
    await advanceBtn.click();
    await hostPage.waitForTimeout(500);

    console.log('📸 Rendering Playback Scene 12: Cinematic SOLD Presentation Overlay...');
    await hostPage.screenshot({ path: path.join(screenshotDir, '09_cinematic_sold_overlay.png') });

    // -------------------------------------------------------------
    // PLAYBACK SCENE 8: Skip Remaining Set
    // -------------------------------------------------------------
    // Wait for next lot or advance
    await hostPage.waitForTimeout(3200); // 3s display pause
    console.log('📸 Rendering Playback Scene 13: Host Skips Set...');
    const skipSetBtn = await hostPage.waitForSelector('button:has-text("Skip Set")');
    await skipSetBtn.click();
    await hostPage.waitForTimeout(200);

    // Confirm skip set modal if opened
    const confirmBtn = await hostPage.$('button:has-text("Confirm Skip"), button:has-text("Yes, Skip Set")');
    if (confirmBtn) await confirmBtn.click();
    await hostPage.waitForTimeout(400);

    // -------------------------------------------------------------
    // PLAYBACK SCENE 9: Conclude Auction & Cricket Mastermind Verdict
    // -------------------------------------------------------------
    console.log('📸 Rendering Playback Scene 14: Host Concludes Auction...');
    const finishBtn = await hostPage.waitForSelector('button:has-text("Conclude Auction")');
    await finishBtn.click();
    // In-app confirmation dialog (window.confirm was replaced so the timer UI never blocks)
    await hostPage.getByRole('dialog').getByRole('button', { name: /Conclude auction/ }).click();
    await hostPage.waitForTimeout(600);

    // Wait for Results View
    await hostPage.waitForSelector('text=CRICKET MASTERMIND', { timeout: 10000 });
    console.log('📸 Rendering Playback Scene 15: Cricket Mastermind Verdict & Rankings...');
    await hostPage.screenshot({ path: path.join(screenshotDir, '10_mastermind_verdict_screen.png') });

    console.log('\n🎉 RENDER PLAYBACK COMPLETED SUCCESSFULLY!');
    console.log(`All playback screenshots saved in: ${screenshotDir}\n`);

    await hostContext.close();
    await p2Context.close();
  } finally {
    await browser.close();
    server.close();
    await mf.dispose();
  }
}

runRenderPlayback().catch(err => {
  console.error('❌ Playback failed:', err);
  process.exit(1);
});
