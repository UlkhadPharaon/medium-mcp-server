import { chromium, BrowserContext, Page } from 'playwright';
import { join, basename } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { marked } from 'marked';

export interface MediumArticle {
  title: string;
  content: string;
  url?: string;
  publishDate?: string;
  tags?: string[];
  claps?: number;
}

export interface PublishOptions {
  title: string;
  content: string;
  tags?: string[];
  isDraft?: boolean;
}

// IMPORTANT: this UA must stay CONSISTENT between the visible login window and
// the headless background runs. Cloudflare ties its `cf_clearance` cookie to the
// exact User-Agent; if the headed login and the headless work use different UAs
// (e.g. real "Chrome" vs "HeadlessChrome"), the clearance is rejected and every
// headless navigation gets stuck on the "Just a moment…" bot challenge.
// It should also roughly match the bundled Chromium major version.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
];

/**
 * Browser-based Medium client backed by a PERSISTENT Chrome profile.
 *
 * Design notes (the hard-won bits):
 *  - A persistent user-data dir keeps cookies WITH an expiry across restarts, but
 *    Chromium drops pure *session* cookies (Medium's `sid`/`xsrf`) when a context
 *    is closed and reopened. So we ALSO snapshot the full storage state to
 *    `sessionFile` and re-inject it on every launch — this is what carries the
 *    login through the headed→headless switch and across server restarts.
 *  - Cloudflare guards the logged-in pages. We pass it by (a) keeping the UA
 *    identical between headed login and headless work, and (b) waiting out the
 *    "Just a moment…" interstitial after each navigation.
 *  - "Logged in" is verified from the actual page (absence of the header Sign-in
 *    button), not just cookie presence — Medium sets `sid`/`uid` for anonymous
 *    visitors too, so cookie presence alone is not proof of authentication.
 */
export class BrowserMediumClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentHeadless: boolean | null = null;

  // Stable locations, independent of where the MCP server is launched from.
  // MEDIUM_SESSION_DIR overrides the parent folder for both.
  private sessionDir = process.env.MEDIUM_SESSION_DIR || homedir();
  private userDataDir = join(this.sessionDir, '.medium-mcp-chrome');
  private sessionFile = join(this.sessionDir, '.medium-mcp-session.json');

  /**
   * Headless mode is OFF by default and should stay that way: Medium's
   * Cloudflare challenge serves an interstitial to headless Chromium, so
   * article reads come back empty. MEDIUM_HEADLESS=true is an escape hatch
   * for servers with no display, not a speed optimisation.
   */
  private headlessPreferred = process.env.MEDIUM_HEADLESS === 'true';

  private readonly PUBLISHED_URL = 'https://medium.com/me/stories?tab=posts-published';

  /** Kept for API compatibility. Browser launches lazily on first use. */
  async initialize(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Browser lifecycle
  // ---------------------------------------------------------------------------

  private async ensureBrowser(headless: boolean): Promise<void> {
    if (this.context && this.currentHeadless === headless && this.page && !this.page.isClosed()) {
      return;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }

    mkdirSync(this.userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless,
      viewport: { width: 1280, height: 800 },
      userAgent: USER_AGENT,
      args: LAUNCH_ARGS,
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.currentHeadless = headless;

    // Re-inject saved cookies (incl. session cookies the on-disk profile drops),
    // unless the fresh context already carries an authenticated cookie.
    if (!(await this.hasAuthCookie())) {
      await this.seedFromSessionFile();
    }
  }

  /** Heuristic: `xsrf` is set by Medium only for an authenticated session. */
  private async hasAuthCookie(): Promise<boolean> {
    if (!this.context) return false;
    const cookies = await this.context.cookies('https://medium.com');
    return cookies.some(c => c.name === 'xsrf');
  }

  private async seedFromSessionFile(): Promise<void> {
    if (!this.context || !existsSync(this.sessionFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
      if (Array.isArray(state.cookies) && state.cookies.length > 0) {
        await this.context.addCookies(state.cookies);
      }
    } catch (error) {
      console.error('Failed to restore session cookies:', error);
    }
  }

  private async persistState(): Promise<void> {
    if (!this.context) return;
    try {
      const state = await this.context.storageState();
      writeFileSync(this.sessionFile, JSON.stringify(state));
    } catch (error) {
      console.error('Failed to persist session state:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloudflare + auth helpers
  // ---------------------------------------------------------------------------

  /** Wait out the Cloudflare "Just a moment…" interstitial after a navigation. */
  private async waitForChallenge(timeoutMs = 45000): Promise<void> {
    if (!this.page) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const title = (await this.page.title().catch(() => '')) || '';
      const isChallenge =
        /just a moment|bir dakika|lütfen|moment|checking|security verif|doğrulama|verify you/i.test(title);
      if (!isChallenge) break;
      await this.page.waitForTimeout(1500);
    }
    // Small settle delay for the SPA to hydrate after the challenge clears.
    await this.page.waitForTimeout(1500);
  }

  /** Is the currently loaded page authenticated? (No header Sign-in button.) */
  private async isPageLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    return await this.page
      .evaluate(() => !document.querySelector('[data-testid="headerSignInButton"]') &&
        !!document.querySelector('[data-testid="headerUserIcon"], [data-testid="headerWriteButton"]'))
      .catch(() => false);
  }

  /**
   * Ensure we have an authenticated session. Returns instantly if already logged
   * in (headless/background). Otherwise opens ONE visible window for sign-in,
   * then drops back to headless. The login is reused silently afterwards.
   */
  async ensureLoggedIn(): Promise<boolean> {
    // Fast path: verify auth in the background context. The mode follows
    // headlessPreferred — by default that is HEADED, because headless Chromium
    // gets a Cloudflare interstitial and the auth check would read the
    // challenge page as "not logged in", forcing a pointless login every time.
    await this.ensureBrowser(this.headlessPreferred);
    if (await this.verifyLoggedIn()) return true;

    // Need the user: relaunch the SAME profile with a visible window.
    console.error('🔐 No valid session — opening a one-time login window...');
    await this.ensureBrowser(false);
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto('https://medium.com/m/signin', { waitUntil: 'domcontentloaded' });
    console.error('🔐 Complete sign-in (and any 2FA) in the opened window. This is a ONE-TIME step.');

    // Poll until Medium issues the authenticated `xsrf` cookie.
    const start = Date.now();
    let authed = false;
    while (Date.now() - start < 300000) {
      if (await this.hasAuthCookie()) { authed = true; break; }
      await this.page.waitForTimeout(1500);
    }

    if (!authed) {
      console.error('❌ Login timed out after 5 minutes.');
      return false;
    }

    // Snapshot the full session NOW (captures session cookies + cf_clearance),
    // then return to the background context that re-seeds from it.
    await this.persistState();
    console.error('✅ Login captured. Session saved for future runs.');
    await this.ensureBrowser(this.headlessPreferred);
    return await this.verifyLoggedIn();
  }

  /** Navigate to the homepage, clear Cloudflare, and confirm authentication. */
  private async verifyLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    await this.page.goto('https://medium.com', { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    const ok = await this.isPageLoggedIn();
    if (ok) await this.persistState();
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  /** Retrieve the signed-in user's own published stories. */
  async getUserArticles(): Promise<MediumArticle[]> {
    if (!(await this.ensureLoggedIn())) {
      throw new Error('Medium login was not completed (timed out or cancelled).');
    }
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto(this.PUBLISHED_URL, { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    // Give the story list time to render.
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const articles = await this.page.evaluate(() => {
      const results: { title: string; content: string; url: string; publishDate: string; tags: string[] }[] = [];
      const seen = new Set<string>();

      const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const url = (a.href || '').split('?')[0];
        const text = (a.textContent || '').trim();
        // A published story link looks like /@user/slug-<hexid> or /pub/slug-<hexid>
        const isStory = /\/[^/]+\/.+-[0-9a-f]{6,}$/.test(url) || /\/p\/[0-9a-f]+$/.test(url);
        if (!isStory || text.length < 8) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({ title: text, content: '', url, publishDate: '', tags: [] });
      }
      return results;
    });

    await this.persistState();
    return articles;
  }

  /** Fetch the full text of a single article URL. */
  async getArticleContent(url: string, requireLogin: boolean = true): Promise<string> {
    if (requireLogin) {
      if (!(await this.ensureLoggedIn())) {
        throw new Error('Medium login was not completed (timed out or cancelled).');
      }
    }
    // Headed mode: headless Chromium trips Medium's Cloudflare bot challenge and
    // the extraction then runs against the "Attention Required!" interstitial.
    // Must run BEFORE the null check so the browser exists on a cold start.
    await this.ensureBrowser(this.headlessPreferred);
    if (!this.page) throw new Error('Browser not initialized');

    console.error(`📖 Fetching article content from: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const content = await this.page.evaluate(() => {
      const selectors = [
        'article section p',
        '[data-testid="story-content"] p',
        'article p',
        'main p',
        '[role="main"] p',
      ];
      for (const selector of selectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 3) {
          const paragraphs: string[] = [];
          els.forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 20) paragraphs.push(text);
          });
          if (paragraphs.length > 2) return paragraphs.join('\n\n');
        }
      }
      for (const selector of ['article', 'main', '[role="main"]']) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 200) return text.replace(/\s+/g, ' ').substring(0, 8000);
      }
      const pageText = document.body.textContent?.toLowerCase() || '';
      if (/member-only|become a member|sign up to continue|subscribe to read/.test(pageText)) {
        return 'Content appears to be behind a paywall / member-only.';
      }
      return 'Unable to extract article content (unsupported layout or paywall).';
    });

    console.error(`✅ Content extracted (${content.length} chars).`);
    await this.persistState();
    return content;
  }

  /**
   * Paste HTML into the focused Medium editor. Medium converts pasted HTML into
   * native blocks (headings, lists, code blocks) and uploads pasted image files
   * to its own CDN.
   */
  private async pasteHtml(html: string): Promise<void> {
    await this.page!.evaluate((h) => {
      const dt = new DataTransfer();
      dt.setData('text/html', h);
      dt.setData('text/plain', h.replace(/<[^>]+>/g, ''));
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, html);
    await this.page!.waitForTimeout(1000);
  }

  /**
   * Markdown -> HTML shaped for Medium's paste handler. Quirks handled here:
   *  - a pasted <pre> is split into a separate code block at every blank line, so
   *    blank lines inside code are collapsed to a single space;
   *  - a blockquote wrapping a <p> renders extra empty quote blocks, so quotes are
   *    flattened to bare text;
   *  - Medium has no table model: a pasted <table> is flattened into plain text.
   *    Tables are converted to a bullet list instead of being silently mangled.
   */
  private async markdownToEditorHtml(markdown: string): Promise<string> {
    const html = await marked.parse(markdown);

    // Tables -> bullet list (Medium has no table support).
    const withoutTables = html.replace(/<table>[\s\S]*?<\/table>/g, (table: string) => {
      const rows = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];
      const lines: string[] = [];
      for (const row of rows) {
        const cells = (row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/g) || []).map((c) =>
          c.replace(/<[^>]+>/g, '').trim()
        );
        if (cells.length) lines.push(`<p>- ${cells.join(' - ')}</p>`);
      }
      return lines.join('');
    });

    return withoutTables
      .replace(/<pre>[\s\S]*?<\/pre>/g, (pre: string) => pre.replace(/\n(?=\n)/g, '\n '))
      .replace(/<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g, '<blockquote>$1</blockquote>');
  }

  /** Paste an image file into the editor and wait for Medium's CDN upload. */
  private async pasteImage(path: string): Promise<void> {
    const base64 = readFileSync(path).toString('base64');
    const before = await this.page!.locator('.postArticle-content img.graf-image').count();
    await this.page!.evaluate(({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'image/png' }));
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, { b64: base64, name: basename(path) });
    // Wait until the upload finishes and the image is served from Medium's CDN
    await this.page!.waitForFunction(
      (n: number) => {
        const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.postArticle-content img.graf-image'));
        return imgs.length > n && imgs.every((i) => i.src.includes('cdn-images'));
      },
      before,
      { timeout: 60000 }
    );
  }

  /**
   * Content is Markdown. Local images (`![alt](/absolute/path.png)`) are uploaded
   * through the editor. Medium autosaves everything as a draft, so isDraft just
   * stops before the publish flow and returns the draft's edit URL.
   */
  async publishArticle(options: PublishOptions): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!(await this.ensureLoggedIn())) {
      return { success: false, error: 'Medium login was not completed (timed out or cancelled).' };
    }
    if (!this.page) throw new Error('Browser not initialized');

    try {
      await this.page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded' });
      await this.waitForChallenge();
      await this.page.waitForLoadState('networkidle').catch(() => {});

      // Current Medium editor: a contenteditable .postArticle-content whose title
      // is an h3.graf--title. The old [data-testid="richTextEditor"] is gone.
      // The title element carries compound classes (h3.graf.graf--h3.graf--title),
      // so match on the leaf class rather than an exact class list.
      const titleSelector = '.postArticle-content[contenteditable="true"] h3.graf--title';
      try {
        await this.page.waitForSelector(titleSelector, { timeout: 20000 });
      } catch {
        // Medium's editor occasionally fails to mount on first load; reload once.
        await this.page.reload();
        await this.page.waitForSelector(titleSelector, { timeout: 30000 });
      }

      // Medium's editor has its own data model and only accepts real input events.
      // page.fill() / setting textContent bypasses that model and the title ends up
      // visually present but NOT saved — so type it, and force an input event.
      await this.page.click(titleSelector);
      await this.page.keyboard.type(options.title);
      await this.page.waitForTimeout(500);
      // Enter creates the first body paragraph and moves focus out of the title,
      // so the HTML paste lands in the body instead of the title field.
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(300);

      // Paste the whole document once, with a placeholder paragraph where each
      // image goes; then swap each placeholder for its uploaded image in place.
      const imageRe = /!\[[^\]]*\]\((\/[^)\s]+\.(?:png|jpe?g|gif))\)/gi;
      const images: string[] = [];
      const withTokens = options.content.replace(imageRe, (_m, path: string) => {
        if (!existsSync(path)) throw new Error(`Image not found: ${path}`);
        images.push(path);
        return `\n\nIMGTOKEN${images.length - 1}X\n\n`;
      });
      await this.pasteHtml(await this.markdownToEditorHtml(withTokens));
      await this.page.waitForTimeout(1500);

      for (let i = 0; i < images.length; i++) {
        // Select the placeholder text through the DOM (a mouse click can be
        // intercepted by a neighbouring figure), delete it, and leave the caret
        // in the empty paragraph.
        const found = await this.page.evaluate((tok: string) => {
          const editor = document.querySelector<HTMLElement>('.postArticle-content[contenteditable="true"]');
          const el = Array.from(document.querySelectorAll('.postArticle-content p.graf'))
            .find((p) => p.textContent?.trim() === tok);
          if (!editor || !el) return false;
          editor.focus();
          el.scrollIntoView({ block: 'center' });
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }, `IMGTOKEN${i}X`);
        if (!found) throw new Error(`Image placeholder ${i} not found in editor`);
        await this.page.keyboard.press('Backspace');
        await this.pasteImage(images[i]);
      }

      // Give Medium's autosave time to persist the draft
      await this.page.waitForURL(/\/p\/[0-9a-f]+\/edit/, { timeout: 30000 });
      await this.page.waitForTimeout(3000);
      const draftUrl = this.page.url();

      if (options.isDraft) {
        await this.persistState();
        return { success: true, url: draftUrl };
      }

      // Live publish: open the publish dialog, add tags, confirm.
      await this.page.locator('button:has-text("Publish")').first().click();
      await this.page.waitForTimeout(2000);
      if (options.tags?.length) {
        const tagInput = this.page
          .locator('[data-testid="publishTopicsInput"], input[placeholder*="topic" i], input[placeholder*="tag" i]')
          .first();
        for (const tag of options.tags.slice(0, 5)) {
          await tagInput.fill(tag);
          await this.page.keyboard.press('Enter');
        }
      }
      await this.page.locator('button:has-text("Publish now")').first().click();
      await this.page.waitForLoadState('networkidle').catch(() => {});
      await this.persistState();
      return { success: true, url: this.page.url() };
    } catch (error) {
      return { success: false, error: `Publishing failed: ${error}` };
    }
  }

  /** Search Medium (no login required). */
  async searchMediumArticles(keywords: string[]): Promise<MediumArticle[]> {
    // Headed for the same reason as getArticleContent: headless trips Cloudflare.
    await this.ensureBrowser(this.headlessPreferred);
    if (!this.page) throw new Error('Browser not initialized');

    const searchQuery = keywords.join(' ');
    console.error(`🔍 Searching Medium for: "${searchQuery}"`);

    await this.page.goto(`https://medium.com/search?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForChallenge();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const articles = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];

      for (const a of anchors) {
        let href = a.href || '';
        const text = (a.textContent || '').trim();
        if (href.includes('redirect=')) {
          const m = href.match(/redirect=([^&]+)/);
          if (m) href = decodeURIComponent(m[1]);
        }
        // Strip the query BEFORE matching. Medium appends tracking params such as
        // ?source=search_post---------0--- to AUTHOR links; matching on the raw
        // href made `a[href*="/@"][href*="-"]` hit the author profile instead of
        // the article, and the query-strip then deleted the real path.
        href = href.split('?')[0];

        // A Medium article URL is /@user/slug-<hex-id> or /publication/slug-<hex-id>.
        const looksLikeArticle = /\/[^/]+\/.+-[0-9a-f]{6,}$/.test(href) || /\/p\/[0-9a-f]+$/.test(href);
        const isJunk = /\/(signin|signup|search|bookmark|tag|me)\b/.test(href);
        if (looksLikeArticle && !isJunk && text.length > 12 && !seen.has(href)) {
          seen.add(href);
          results.push({ title: text, content: '', url: href, publishDate: '', tags: [], claps: 0 });
        }
      }
      return results;
    });

    console.error(`🎉 Search completed. Found ${articles.length} articles.`);
    return articles;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.currentHeadless = null;
    }
  }
}
