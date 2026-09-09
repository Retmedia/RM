import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, '.studio-data');
const FILE = join(DIR, 'studio.json');
const TMP = join(DIR, 'studio.json.tmp');

const EMPTY = { creators: [], grants: {}, posts: [] };

let cache = null;

export function load() {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = structuredClone(EMPTY);
    return cache;
  }
  try {
    cache = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    // A half-written snapshot should not take the desk down. Start clean and say so.
    console.error('[store] snapshot unreadable, starting empty');
    cache = structuredClone(EMPTY);
  }
  return cache;
}

// Single process only. Two writers would race this rename; see README before scaling out.
export function save(next) {
  cache = next;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(TMP, JSON.stringify(next, null, 2));
  renameSync(TMP, FILE);
  return cache;
}

export function update(fn) {
  const data = load();
  const next = fn(structuredClone(data)) || data;
  return save(next);
}

export const paths = { DIR, FILE };
