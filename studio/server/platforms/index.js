const instagram = require('./instagram');
const tiktok = require('./tiktok');
const facebook = require('./facebook');
const youtube = require('./youtube');

const platforms = { instagram, tiktok, facebook, youtube };

function get(id) {
  const p = platforms[id];
  if (!p) throw new Error(`Unknown platform: ${id}`);
  return p;
}

function listMeta() {
  return Object.values(platforms).map((p) => p.meta);
}

module.exports = { platforms, get, listMeta };
