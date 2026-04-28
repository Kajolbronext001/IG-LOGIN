const chromium = require('chrome-aws-lambda');
const { authenticator } = require('otplib');

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { username, password, twofaSecret } = JSON.parse(event.body);
    if (!username || !password) {
      throw new Error('username and password required');
    }

    const result = await loginAndGetCookies(username, password, twofaSecret);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, cookies: result }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

async function loginAndGetCookies(username, password, twofaSecret) {
  let browser = null;
  try {
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    );

    // 1. Login page
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });

    // Accept cookies if popup appears (optional)
    try {
      await page.waitForSelector('button[type="button"]:has(div)', { timeout: 3000 });
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.includes('Allow all cookies') || text.includes('Allow essential')) {
          await btn.click();
          break;
        }
      }
    } catch (_) {}

    // Fill credentials
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.type('input[name="username"]', username, { delay: 50 });
    await page.type('input[name="password"]', password, { delay: 50 });

    // Click login
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    // 2. Check for 2FA verification
    const twoFASelector = 'input[name="verificationCode"]';
    const is2FA = await page.$(twoFASelector);
    if (is2FA) {
      if (!twofaSecret) {
        throw new Error('2FA required but secret not provided');
      }
      // Generate TOTP code
      const token = authenticator.generate(twofaSecret.replace(/\s/g, ''));
      await page.type(twoFASelector, token, { delay: 50 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

      // Sometimes Instagram asks "Trust this browser?" – we can click "Not Now"
      try {
        const trustBtn = await page.waitForSelector('button:has(span)', { timeout: 3000 });
        const text = await page.evaluate(el => el.textContent, trustBtn);
        if (text.includes('Not Now')) {
          await trustBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch (_) {}
    }

    // 3. Check for "Save Your Login Info" – click "Not Now"
    try {
      const saveBtn = await page.waitForSelector('button:has(span)', { timeout: 4000 });
      const text = await page.evaluate(el => el.textContent, saveBtn);
      if (text.includes('Not Now')) {
        await saveBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (_) {}

    // Wait for successful login (look for nav icons)
    await page.waitForSelector('svg[aria-label="Home"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 4. Extract cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    return cookieString;
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}