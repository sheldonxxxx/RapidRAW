/** Independent, dependency-free PNG fixture writer/decoder for exact native pixel assertions. */
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  type.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([type, data])), out.length - 4);
  return out;
}
export function fixturePng(
  width = 256,
  height = 192,
  pixel = (x, y) => {
    const texture = (((x * 17 + y * 29) % 19) - 9) * 2;
    return [
      32 + (x / width) * 175 + texture,
      28 + (y / height) * 180 - texture,
      40 + ((Math.floor(x / 24) + Math.floor(y / 24)) % 2) * 130,
    ];
  },
  extraChunks = [],
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (const [c, value] of pixel(x, y).entries())
        rows[y * (width * 3 + 1) + 1 + x * 3 + c] = Math.round(Math.max(0, Math.min(255, value)));
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    ...extraChunks.map(({ type, data }) => chunk(type, data)),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Minimal real EXIF TIFF with GPS IFD; positive/negative GPS tests cannot pass on absent metadata. */
export function gpsExifFixture() {
  const bytes = Buffer.alloc(152);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8); // IFD0 GPSInfo pointer.
  bytes.writeUInt16LE(0x8825, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt16LE(4, 26);
  const entry = (offset, tag, type, count, value) => {
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(value, offset + 8);
  };
  entry(28, 1, 2, 2, 78); // ASCII N\0 inline.
  entry(40, 2, 5, 3, 80);
  entry(52, 3, 2, 2, 69); // ASCII E\0 inline.
  entry(64, 4, 5, 3, 104);
  for (const [i, value] of [22, 10, 0, 113, 30, 0].entries()) {
    bytes.writeUInt32LE(value, 80 + i * 8);
    bytes.writeUInt32LE(1, 84 + i * 8);
  }
  return bytes.subarray(0, 128);
}
/** Real synthetic exposure/ISO EXIF for mechanical HDR fixtures; not capture provenance. */
export function exposureExifFixture(denominator = 100, iso = 100) {
  assert.ok(Number.isSafeInteger(denominator) && denominator > 0 && denominator <= 0xffffffff);
  assert.ok(Number.isSafeInteger(iso) && iso > 0 && iso <= 0xffff);
  const bytes = Buffer.alloc(64);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(0x8769, 10);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt32LE(26, 18);
  bytes.writeUInt16LE(2, 26);
  bytes.writeUInt16LE(0x829a, 28);
  bytes.writeUInt16LE(5, 30);
  bytes.writeUInt32LE(1, 32);
  bytes.writeUInt32LE(56, 36);
  bytes.writeUInt16LE(0x8827, 40);
  bytes.writeUInt16LE(3, 42);
  bytes.writeUInt32LE(1, 44);
  bytes.writeUInt16LE(iso, 48);
  bytes.writeUInt32LE(1, 56);
  bytes.writeUInt32LE(denominator, 60);
  return bytes;
}
export function decodePng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), signature);
  let width, height, bitDepth, colorType;
  const compressed = [],
    chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    assert.ok(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const size = bytes.readUInt32BE(offset),
      type = bytes.toString('ascii', offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, offset + 8 + size);
    assert.ok(offset + size + 12 <= bytes.length, 'PNG chunk out of bounds');
    assert.equal(
      crc32(bytes.subarray(offset + 4, offset + 8 + size)),
      bytes.readUInt32BE(offset + 8 + size),
      `Bad ${type} CRC`,
    );
    chunks.push({ type, data });
    if (type === 'IHDR') {
      width = data.readUInt32BE();
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      assert.equal(data[12], 0, 'Interlaced PNG is unsupported by independent test decoder');
    }
    if (type === 'IDAT') compressed.push(data);
    offset += size + 12;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels && [8, 16].includes(bitDepth), `Unsupported PNG layout ${colorType}/${bitDepth}`);
  const bpp = (channels * bitDepth) / 8,
    stride = width * bpp,
    rows = inflateSync(Buffer.concat(compressed));
  assert.equal(rows.length, (stride + 1) * height);
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? decoded[y * stride + x - bpp] : 0,
        b = y ? decoded[(y - 1) * stride + x] : 0,
        c = y && x >= bpp ? decoded[(y - 1) * stride + x - bpp] : 0;
      decoded[y * stride + x] =
        (rows[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255;
    }
  }
  const pixels = new Float64Array(width * height * 3),
    max = bitDepth === 16 ? 65535 : 255;
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++) {
      const channel = channels < 3 ? 0 : c,
        offset = ((i * channels + channel) * bitDepth) / 8;
      pixels[i * 3 + c] = (bitDepth === 16 ? decoded.readUInt16BE(offset) : decoded[offset]) / max;
    }
  return { width, height, bitDepth, colorType, channels, pixels, chunks };
}
export function mean(image, region = { x: 0, y: 0, width: image.width, height: image.height }) {
  let total = 0,
    count = 0;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * image.width + x) * 3;
      total += image.pixels[i] * 0.2126 + image.pixels[i + 1] * 0.7152 + image.pixels[i + 2] * 0.0722;
      count++;
    }
  return total / count;
}
export function pixelDifference(a, b, region = { x: 0, y: 0, width: a.width, height: a.height }) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0,
    max = 0;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * a.width + x) * 3 + c,
          d = Math.abs(a.pixels[i] - b.pixels[i]);
        sum += d;
        max = Math.max(max, d);
      }
  return { mean_absolute: sum / (region.width * region.height * 3), maximum: max };
}
