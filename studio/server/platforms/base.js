// Shared helpers for platform adapters.
//
// Every adapter exports the same shape so the publisher and the UI never need a
// per-platform branch:
//
//   meta          static description, limits and multi-account behaviour
//   authUrl()     where to send the browser to start OAuth
//   exchangeCode() code -> tokens
//   discover()    tokens -> the list of postable accounts behind that login
//   validate()    post + media -> [] or a list of blocking problems
//   publish()     actually put the post live, returns { remoteId, remoteUrl }

const DRY_RUN = process.env.STUDIO_DRY_RUN !== '0';

class PlatformError extends Error {
  constructor(message, { retryable = false, needsReauth = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.needsReauth = needsReauth;
  }
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const message = body?.error?.message || body?.error_description || body?.message || `HTTP ${res.status}`;
    throw new PlatformError(`${message}`, {
      // 5xx and explicit rate-limit responses are worth another attempt later;
      // a 400 means the request itself is wrong and retrying changes nothing.
      retryable: res.status >= 500 || res.status === 429,
      needsReauth: res.status === 401 || res.status === 403,
    });
  }
  return body;
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new PlatformError(
      `Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. See studio/.env.example.`,
    );
  }
}

function redirectUri(platform) {
  const base = process.env.STUDIO_PUBLIC_URL || 'http://localhost:4400';
  return `${base}/auth/${platform}/callback`;
}

// A stand-in publish used until real app credentials are in place, so the
// planner, scheduler and retry logic can be exercised end to end.
function simulatePublish(platform, account) {
  const remoteId = `dry_${Date.now().toString(36)}`;
  return {
    remoteId,
    remoteUrl: `https://example.invalid/${platform}/${account.username || account.platformAccountId}/${remoteId}`,
    dryRun: true,
  };
}

module.exports = { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish };
