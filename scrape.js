import { chromium } from 'playwright';
import { format, utcToZonedTime } from 'date-fns-tz';

// 設定
const LINKTREE_EMAIL = process.env.LINKTREE_EMAIL;
const LINKTREE_PASSWORD = process.env.LINKTREE_PASSWORD;
const LT_COOKIE = process.env.LT_COOKIE;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// バケット定義
const BUCKETS = ['SP', 'CP', 'TikTok', 'SNS', 'Design', 'CAS'];

// リトライ関数
async function retry(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`Attempt ${i + 1} failed:`, error.message);
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
}

// 日付フォーマット（JST）
function getJSTDate() {
  const now = new Date();
  const jst = utcToZonedTime(now, 'Asia/Tokyo');
  return format(jst, 'yyyy-MM-dd');
}

// Cookie文字列をパースしてPlaywright用のCookieオブジェクトに変換
function parseCookies(cookieString) {
  const cookies = [];
  const pairs = cookieString.split(';');
  
  for (const pair of pairs) {
    const [name, value] = pair.trim().split('=');
    if (name && value) {
      cookies.push({
        name: name.trim(),
        value: value.trim(),
        domain: '.linktr.ee',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      });
    }
  }
  
  return cookies;
}

// GAS Webhookにデータを送信
async function sendToWebhook(data) {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data)
    });
    
    const responseText = await response.text();
    console.log(`Webhook status: ${response.status} ${responseText}`);
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${responseText}`);
    }
    
    return responseText;
  } catch (error) {
    console.error('Webhook error:', error);
    throw error;
  }
}

// メイン処理
async function main() {
  console.log('Starting Linktree insights scraper...');
  
  if (!WEBHOOK_URL) {
    throw new Error('Missing required environment variable: WEBHOOK_URL');
  }
  
  const today = getJSTDate();
  console.log(`Today: ${today}`);
  
  // ブラウザ起動
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    // Cookie認証を試行
    if (LT_COOKIE) {
      console.log('Using cookie authentication...');
      try {
        const cookies = parseCookies(LT_COOKIE);
        await context.addCookies(cookies);
        await page.goto('https://linktr.ee/admin/links', { waitUntil: 'networkidle' });
        
        // ログイン画面にリダイレクトされていないかチェック
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
          throw new Error('Cookie authentication failed - redirected to login');
        }
        
        console.log('Cookie authentication successful');
      } catch (error) {
        console.log('Cookie authentication failed, falling back to login:', error.message);
        // フォールバック: 通常ログイン
        if (!LINKTREE_EMAIL || !LINKTREE_PASSWORD) {
          throw new Error('Cookie authentication failed and no login credentials available');
        }
        
        await retry(async () => {
          await page.goto('https://linktr.ee/login', { waitUntil: 'networkidle' });
          await page.fill('input[type="email"]', LINKTREE_EMAIL);
          await page.fill('input[type="password"]', LINKTREE_PASSWORD);
          await page.click('button[type="submit"]');
          await page.waitForURL('**/admin**', { timeout: 10000 });
        });
      }
    } else {
      // Cookie認証なし: 通常ログイン
      console.log('Using email/password authentication...');
      if (!LINKTREE_EMAIL || !LINKTREE_PASSWORD) {
        throw new Error('No authentication method available');
      }
      
      await retry(async () => {
        await page.goto('https://linktr.ee/login', { waitUntil: 'networkidle' });
        await page.fill('input[type="email"]', LINKTREE_EMAIL);
        await page.fill('input[type="password"]', LINKTREE_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForURL('**/admin**', { timeout: 10000 });
      });
    }
    
    // 全リンクを読み込むためにスクロール
    console.log('Loading all links...');
    await retry(async () => {
      let previousHeight = 0;
      let currentHeight = await page.evaluate(() => document.body.scrollHeight);
      
      while (currentHeight > previousHeight) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
        previousHeight = currentHeight;
        currentHeight = await page.evaluate(() => document.body.scrollHeight);
      }
    });
    
    // リンクデータを抽出
    console.log('Extracting link data...');
    const linkData = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="link-card"], .link-card, [class*="link-card"]');
      const links = [];
      
      for (const card of cards) {
        try {
          // クリック数抽出
          const clickElement = card.querySelector('[class*="click"], [class*="Click"], [data-testid*="click"]') ||
                              Array.from(card.querySelectorAll('*')).find(el => 
                                el.textContent && /\d+\s+clicks?/.test(el.textContent)
                              );
          
          const clicks = clickElement ? parseInt(clickElement.textContent.match(/(\d+)/)?.[1] || 0 : 0;
          
          // タイトル抽出
          const titleElement = card.querySelector('input[aria-label="Title"], [data-testid="link-title"], h3, textarea') ||
                              card.querySelector('[class*="title"], [class*="Title"]');
          const title = titleElement?.value || titleElement?.textContent?.trim() || '';
          
          // URL抽出
          const urlElement = card.querySelector('a[href^="http"]');
          const url = urlElement?.href || '';
          
          if (title && url) {
            links.push({ title, url, clicks });
          }
        } catch (error) {
          console.log('Error extracting link data:', error);
        }
      }
      
      return links;
    });
    
    console.log(`Extracted ${linkData.length} links`);
    
    // GAS Webhookにデータを送信
    const webhookData = {
      dateISO: today,
      items: linkData
    };
    
    await sendToWebhook(webhookData);
    console.log('Scraping completed successfully');
    
  } catch (error) {
    console.error('Scraping failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// 実行
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
