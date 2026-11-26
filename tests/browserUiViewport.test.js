// Browser UI Viewport & DOM Verification (Desktop & Mobile)
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from './e2e/harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, '..', 'client', 'dist');

test('Browser UI Viewport & Layout Verification', async (t) => {
  // 1. Serve client/dist via Express on ephemeral local port
  const app = express();
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Static Server] Serving client/dist on ${baseUrl}`);

  // 2. Launch Google Chrome
  const chromePath = findChrome();
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });

  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    console.log('[Cleanup] Browser and static server closed cleanly.');
  });

  // Test 1: Desktop Viewport (1280x800)
  await t.test('1. Desktop viewport landing view layout and modal interaction', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // Verify main landing heading
    const title = await page.textContent('h1');
    assert.ok(title.includes('IPL MULTIPLAYER') || title.includes('AUCTION'));
    console.log('[Desktop] Heading loaded:', title.trim().replace(/\s+/g, ' '));

    // Verify Create Room and Join Room action buttons exist
    const createBtn = await page.$('button:has-text("Create Private Room")');
    const joinBtn = await page.$('button:has-text("Join with Room Code")');
    assert.ok(createBtn, 'Create Room button must be visible on desktop');
    assert.ok(joinBtn, 'Join Room button must be visible on desktop');

    // Click Create Room to trigger modal
    await createBtn.click();
    await page.waitForTimeout(200);

    // Verify input fields inside modal
    const nameInput = await page.$('input[placeholder*="name" i], input[type="text"]');
    assert.ok(nameInput, 'Name input must be visible in modal');

    await context.close();
  });

  // Test 2: Mobile Viewport (390x844 - iPhone / Modern Android)
  await t.test('2. Mobile viewport portrait layout and responsiveness', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // Verify page width fits viewport without horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    assert.ok(scrollWidth <= innerWidth + 1, `Mobile layout should not horizontally scroll (scrollWidth: ${scrollWidth}, innerWidth: ${innerWidth})`);

    // Verify mobile action buttons
    const createBtn = await page.$('button:has-text("Create Private Room")');
    assert.ok(createBtn, 'Create Room button must be visible on mobile');

    await createBtn.click();
    await page.waitForTimeout(200);

    const modalInput = await page.$('input[placeholder*="name" i], input[type="text"]');
    assert.ok(modalInput, 'Modal input should be accessible on mobile');

    await context.close();
  });
});
