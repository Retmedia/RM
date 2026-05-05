#!/usr/bin/env node
import { mkdir, chmod, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const binDir = resolve(projectRoot, 'bin');

const platform = process.platform;
const asset =
  platform === 'win32'  ? 'yt-dlp.exe' :
  platform === 'darwin' ? 'yt-dlp_macos' :
                          'yt-dlp';
const finalName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;

await mkdir(binDir, { recursive: true });

function fetchFollow(url, depth = 0) {
  return new Promise((resolveP, rejectP) => {
    if (depth > 6) return rejectP(new Error('too many redirects'));
    httpsGet(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return fetchFollow(res.headers.location, depth + 1).then(resolveP, rejectP);
      }
      if (res.statusCode !== 200) {
        return rejectP(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolveP(res);
    }).on('error', rejectP);
  });
}

const tmp = resolve(binDir, `${finalName}.partial`);
console.log(`Downloading ${asset}...`);
const res = await fetchFollow(url);
await pipeline(res, createWriteStream(tmp));
await rename(tmp, resolve(binDir, finalName));
if (platform !== 'win32') {
  await chmod(resolve(binDir, finalName), 0o755);
}
console.log(`Installed bin/${finalName}`);
