import { chromium } from 'playwright';

const OUT = 'C:/Users/Admin/AppData/Local/Temp/claude-screenshots';
const BASE = 'http://localhost:8000';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });

// Home
await page.goto(BASE + '/');
await page.waitForTimeout(3500);
await page.screenshot({ path: OUT + '/home.png' });
console.log('home ok');

// Product page (as guest)
const href = await page.locator('a[href^="/products/"]').first().getAttribute('href');
await page.goto(BASE + href);
await page.waitForTimeout(2000);
await page.screenshot({ path: OUT + '/product-guest.png', fullPage: true });
console.log('product (guest) ok');

// Scroll to review section
await page.locator('text=Shopper feedback').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + '/product-review-section.png' });
console.log('review section ok');

// Deals page
await page.goto(BASE + '/deals');
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + '/deals.png', fullPage: false });
console.log('deals ok');

// Sign in page
await page.goto(BASE + '/signin');
await page.waitForTimeout(1000);
await page.screenshot({ path: OUT + '/signin.png' });
console.log('signin ok');

await browser.close();
console.log('all done');
