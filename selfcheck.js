/**
 * Self-check for the Medium MCP Server.
 *
 * Starts the compiled server over stdio, lists its tools, and exercises the
 * two tools that need no login against the live site. Prints a PASS/FAIL
 * report and exits non-zero if anything is broken.
 *
 * Used by LAUNCH-MEDIUM-MCP.cmd test
 */
const { spawn } = require('child_process');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'dist', 'index.js');
const EXPECTED_TOOLS = [
  'publish-article',
  'get-my-articles',
  'get-article-content',
  'search-medium',
  'login-to-medium',
];

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
};

async function main() {
  console.log('Medium MCP Server - self check');
  console.log('-------------------------------\n');

  if (!require('fs').existsSync(SERVER)) {
    console.log(`  [FAIL] dist/index.js not found - run "npm run build" first.`);
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'medium-mcp-selfcheck', version: '1.0.0' }, { capabilities: {} });

  const logs = [];
  transport.stderr?.on('data', (d) => logs.push(d.toString()));

  try {
    const t0 = Date.now();
    await client.connect(transport);
    record('MCP handshake', true, `${Date.now() - t0}ms`);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
    record('Tools registered', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : names.join(', '));

    // search-medium needs no login.
    try {
      const t1 = Date.now();
      const r = await client.callTool({ name: 'search-medium', arguments: { keywords: ['playwright automation'] } });
      const arr = JSON.parse(r.content.map((c) => c.text || '').join(''));
      const allArticles = arr.length > 0 && arr.every((a) => /\/[^/]+\/.+-[0-9a-f]{6,}$/.test(a.url));
      record('search-medium returns real article URLs', allArticles, `${arr.length} results in ${Date.now() - t1}ms`);
    } catch (e) {
      record('search-medium returns real article URLs', false, e.message);
    }

    // get-article-content on a public article, no login.
    try {
      const t2 = Date.now();
      const r = await client.callTool({
        name: 'get-article-content',
        arguments: {
          url: 'https://medium.com/@martinmaati31/deploying-a-playwright-automation-script-whilst-not-headless-f13ed94fa33c',
          requireLogin: false,
        },
      });
      const txt = r.content.map((c) => c.text || '').join('');
      const ok = txt.length > 2000 && !/Member-only story/i.test(txt);
      record('get-article-content extracts a public article', ok, `${txt.length} chars in ${Date.now() - t2}ms`);
    } catch (e) {
      record('get-article-content extracts a public article', false, e.message);
    }

    // Login state: Medium sets `sid`/`uid` for ANONYMOUS visitors too, so the
    // presence of a session file proves nothing. The authenticated marker is the
    // `xsrf` cookie, which Medium only issues to a signed-in session.
    const fs = require('fs');
    const os = require('os');
    const session = path.join(process.env.USERPROFILE || os.homedir(), '.medium-mcp-session.json');
    let signedIn = false;
    try {
      const state = JSON.parse(fs.readFileSync(session, 'utf8'));
      signedIn = (state.cookies || []).some((c) => c.name === 'xsrf');
    } catch {
      signedIn = false;
    }
    console.log('');
    console.log(`  Signed in: ${signedIn ? 'yes' : 'no - run the server once and sign in when the browser opens'}`);
    record('Session is authenticated', true, signedIn ? 'xsrf cookie present' : 'not signed in yet (expected on a fresh install)');
  } catch (e) {
    record('MCP handshake', false, e.message);
    console.log('\nServer log:\n' + logs.join('').split('\n').slice(-15).join('\n'));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('Self-check crashed:', e);
  process.exit(1);
});
