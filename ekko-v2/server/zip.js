// Minimal in-memory ZIP writer using built-in zlib. No external dependencies.
//
// Supports STORE (method 0) and DEFLATE (method 8). Single-disk archives only
// (no ZIP64). Suitable for transcript vaults — entries are small and total
// archive size stays well under 4GB.

const zlib = require('node:zlib');

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d = new Date()) {
  const t = ((d.getHours() & 0x1F) << 11)
    | ((d.getMinutes() & 0x3F) << 5)
    | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9)
    | (((d.getMonth() + 1) & 0x0F) << 5)
    | (d.getDate() & 0x1F);
  return { time: t, date };
}

class ZipBuilder {
  constructor() {
    this.entries = [];
    this.parts = [];
    this.offset = 0;
    this.now = dosTime(new Date());
  }

  _push(buf) {
    this.parts.push(buf);
    this.offset += buf.length;
  }

  // Adds a file or directory entry. Pass `dir: true` and an empty body for a folder.
  addFile(name, body, { compress = true, dir = false } = {}) {
    if (this.entries.length >= 0xFFFE) {
      throw new Error('Too many entries for a non-ZIP64 archive');
    }
    const nameBuf = Buffer.from(name, 'utf8');
    const data = dir ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    const crc = dir ? 0 : crc32(data);
    let method = 0;
    let stored = data;
    if (!dir && compress && data.length > 0) {
      const def = zlib.deflateRawSync(data, { level: zlib.constants.Z_BEST_COMPRESSION });
      // Only use deflate if it actually wins. Some small inputs grow.
      if (def.length < data.length) {
        method = 8;
        stored = def;
      }
    }
    const localOffset = this.offset;

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);    // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(method, 8);        // compression method
    local.writeUInt16LE(this.now.time, 10);
    local.writeUInt16LE(this.now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    this._push(local);
    this._push(nameBuf);
    if (stored.length) this._push(stored);

    this.entries.push({
      name: nameBuf,
      method,
      crc,
      compressedSize: stored.length,
      uncompressedSize: data.length,
      localOffset,
      isDir: !!dir,
    });
  }

  addDir(name) {
    const n = name.endsWith('/') ? name : name + '/';
    this.addFile(n, '', { compress: false, dir: true });
  }

  finalize() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);   // central dir signature
      cd.writeUInt16LE(20, 4);           // version made by
      cd.writeUInt16LE(20, 6);           // version needed
      cd.writeUInt16LE(0x0800, 8);       // flags
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(this.now.time, 12);
      cd.writeUInt16LE(this.now.date, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressedSize, 20);
      cd.writeUInt32LE(e.uncompressedSize, 24);
      cd.writeUInt16LE(e.name.length, 28);
      cd.writeUInt16LE(0, 30);           // extra length
      cd.writeUInt16LE(0, 32);           // comment length
      cd.writeUInt16LE(0, 34);           // disk number
      cd.writeUInt16LE(0, 36);           // internal attrs
      cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attrs (dir bit)
      cd.writeUInt32LE(e.localOffset, 42);
      this._push(cd);
      this._push(e.name);
    }
    const cdSize = this.offset - cdStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);            // disk number
    eocd.writeUInt16LE(0, 6);            // disk where central dir starts
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);           // comment length
    this._push(eocd);

    return Buffer.concat(this.parts);
  }
}

module.exports = { ZipBuilder, crc32 };
