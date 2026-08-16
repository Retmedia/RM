#!/usr/bin/env node
// Fetches the yt-dlp binary into dogpull/bin. DogPull has no npm dependencies —
// this is the only thing it needs to install.
import { mkdir, chmod, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(__dirname, '..', 'bin');

const asset =
  process.platform === 'win32' ? 'yt-dlp.exe' :
  process.platform === 'darwin' ? 'yt-dlp_macos' :
  'yt-dlp';
const finalName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;

function fetchFollow(target, depth = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (depth > 6) return rejectPromise(new Error('too many redirects'));
    httpsGet(target, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return fetchFollow(res.headers.location, depth + 1).then(resolvePromise, rejectPromise);
      }
      if (res.statusCode !== 200) return rejectPromise(new Error(`HTTP ${res.statusCode} for ${target}`));
      resolvePromise(res);
    }).on('error', rejectPromise);
  });
}

await mkdir(binDir, { recursive: true });
const tmp = resolve(binDir, `${finalName}.partial`);
console.log(`Downloading ${asset} ...`);
await pipeline(await fetchFollow(url), createWriteStream(tmp));
await rename(tmp, resolve(binDir, finalName));
if (process.platform !== 'win32') await chmod(resolve(binDir, finalName), 0o755);
console.log(`Installed bin/${finalName}`);
