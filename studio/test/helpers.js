const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every test file gets its own data directory and its own module registry, so
// nothing leaks between suites and the developer's real vault is never touched.
function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  process.env.STUDIO_DATA = dir;
  process.env.STUDIO_SECRET = 'test-secret-not-a-real-one';
  process.env.STUDIO_DRY_RUN = '1';
  process.env.STUDIO_PLATFORMS = 'tiktok,instagram,x,youtube';
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key];
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Boots the real Express app on an ephemeral port and returns a small client
// that keeps cookies, so auth is exercised the way a browser would.
async function startServer() {
  const { app } = require('../server/server');
  const store = require('../server/store');
  await store.load();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function call(method, url, body, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined && !options.raw) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : (options.raw ? body : JSON.stringify(body)),
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('studio_session=')) {
        cookie = pair.endsWith('=') ? '' : pair;
      }
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    base,
    get: (url, options) => call('GET', url, undefined, options),
    post: (url, body, options) => call('POST', url, body, options),
    patch: (url, body) => call('PATCH', url, body),
    del: (url) => call('DELETE', url),
    signOut: () => { cookie = ''; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const OWNER = { name: 'Garrett', email: 'owner@example.com', password: 'wildwater99' };

async function setupOwner(client) {
  const res = await client.post('/api/setup', OWNER);
  if (res.status !== 200) throw new Error(`setup failed: ${res.text}`);
  return res.body.user;
}

module.exports = { freshEnv, cleanup, startServer, setupOwner, OWNER };
