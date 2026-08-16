const path = require('node:path');
const fsSync = require('node:fs');
const { DEFAULT_HEIGHT, DEFAULT_FPS } = require('./downloads');

const CLIENTS_FILE = path.resolve(__dirname, '..', 'clients.json');

const DEFAULTS = {
  height: DEFAULT_HEIGHT,
  fps: DEFAULT_FPS,
  preferH264: true,
  minDurationSec: 180,
  verified: false,
};

function loadClients() {
  try {
    const raw = fsSync.readFileSync(CLIENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`clients.json is not valid JSON: ${e.message}`);
  }
}

function getClient(name) {
  if (typeof name !== 'string') return null;
  const clients = loadClients();
  const key = Object.keys(clients).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  return key ? { key, ...DEFAULTS, ...clients[key] } : null;
}

function listClients() {
  const clients = loadClients();
  return Object.entries(clients).map(([key, value]) => ({ key, ...DEFAULTS, ...value }));
}

// Records a channel as confirmed so the CLI stops asking on every run.
function markVerified(key, channelUrl) {
  const raw = fsSync.readFileSync(CLIENTS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.clients?.[key]) return false;
  parsed.clients[key].channelUrl = channelUrl;
  parsed.clients[key].verified = true;
  fsSync.writeFileSync(CLIENTS_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

module.exports = { CLIENTS_FILE, loadClients, getClient, listClients, markVerified };
