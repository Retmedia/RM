const crypto = require('node:crypto');
const store = require('./store');

const SESSION_COOKIE = 'studio_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------- passwords */

// scrypt with a per-user salt. Node ships it, so there is no dependency to
// keep patched, and it is deliberately slow to brute force.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length, { N: 16384, r: 8, p: 1 });
  // Constant-time, so a wrong password cannot be narrowed down by timing.
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 10) return 'Use at least 10 characters.';
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return 'Use letters and at least one number.';
  return null;
}

/* -------------------------------------------------------------- cookies */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Secure is set whenever the deployment is actually on HTTPS; forcing it in
// local development would silently drop the cookie and look like a bug.
function setSessionCookie(res, token, { secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function isSecureRequest(req) {
  return req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
}

/* -------------------------------------------------------------- sessions */

async function login({ email, password, userAgent }) {
  const user = await store.findUserByEmail(email);
  // Hash regardless, so a missing account and a wrong password take the same
  // time and cannot be told apart.
  const ok = user && !user.disabledAt && verifyPassword(password, user.passwordHash);
  if (!user) verifyPassword(password, hashPassword('placeholder-to-equalise-timing'));
  if (!ok) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  await store.createSession({
    token,
    userId: user.id,
    userAgent: String(userAgent || '').slice(0, 200),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return { user: publicUser(user), token };
}

async function logout(token) {
  if (token) await store.deleteSession(token);
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

/* ------------------------------------------------------------ middleware */

// Attaches req.user when a valid session cookie is present. Never rejects on
// its own — the guards below decide what needs a user.
function attachUser() {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return next();
      const session = await store.getSession(token);
      if (!session) return next();
      const user = await store.getUser(session.userId);
      if (!user || user.disabledAt) return next();
      req.user = publicUser(user);
      req.sessionToken = token;
      next();
    } catch (err) { next(err); }
  };
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in to continue.' });
}

// Owners administer the agency: people, billing-shaped things, deleting a
// creator. Managers do the daily work and cannot remove anyone.
function requireOwner(req, res, next) {
  if (req.user?.role === 'owner') return next();
  res.status(403).json({ error: 'Only an owner can do that.' });
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  passwordProblem,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  isSecureRequest,
  login,
  logout,
  publicUser,
  attachUser,
  requireAuth,
  requireOwner,
};
