const instagram = require('./instagram');
const tiktok = require('./tiktok');
const x = require('./x');
const facebook = require('./facebook');
const youtube = require('./youtube');

// Every adapter that exists. Which of them this install actually offers is the
// next constant down — Facebook and YouTube are written and working, they are
// just not part of the current product.
const all = { instagram, tiktok, x, facebook, youtube };

const DEFAULT_ENABLED = ['tiktok', 'instagram', 'x'];

const enabled = (process.env.STUDIO_PLATFORMS || DEFAULT_ENABLED.join(','))
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s && all[s]);

if (!enabled.length) enabled.push(...DEFAULT_ENABLED);

function isEnabled(id) {
  return enabled.includes(id);
}

function get(id) {
  const platform = all[id];
  if (!platform) throw new Error(`Unknown platform: ${id}`);
  if (!isEnabled(id)) {
    throw new Error(
      `${platform.meta.name} is switched off for this install. Add it to STUDIO_PLATFORMS to turn it back on.`,
    );
  }
  return platform;
}

// For rendering an account whose platform has since been switched off: enough
// to draw a row without pretending the platform is available.
function describe(id) {
  return all[id] ? { ...all[id].meta, enabled: isEnabled(id) } : { id, name: id, color: '#6b7280', enabled: false };
}

function listMeta() {
  return enabled.map((id) => all[id].meta);
}

module.exports = { platforms: all, get, describe, isEnabled, listMeta, enabled };
