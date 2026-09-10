import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

/** Decode baseline 16-bit TIFF strips, including deflate and horizontal prediction.
 * Deliberately rejects unsupported layouts instead of inferring precision from a header.
 */
export function inspectTiff16(bytes) {
  const little = bytes.subarray(0, 2).toString() === 'II';
  assert.ok(little || bytes.subarray(0, 2).toString() === 'MM', 'Expected TIFF byte order marker');
  const u16 = (offset) => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = (offset) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  assert.equal(u16(2), 42, 'Expected classic TIFF');
  const ifd = u32(4);
  const tags = new Map();
  for (let index = 0; index < u16(ifd); index += 1) {
    const entry = ifd + 2 + 12 * index;
    const tag = u16(entry), type = u16(entry + 2), count = u32(entry + 4);
    if (![3, 4].includes(type)) continue;
    const size = type === 3 ? 2 : 4;
    const offset = size * count <= 4 ? entry + 8 : u32(entry + 8);
    assert.ok(offset + count * size <= bytes.length, 'TIFF tag data exceeds file bounds');
    tags.set(tag, Array.from({ length: count }, (_, i) => type === 3 ? u16(offset + i * size) : u32(offset + i * size)));
  }
  const width = tags.get(256)?.[0], height = tags.get(257)?.[0];
  const bits = tags.get(258), channels = tags.get(277)?.[0] ?? 1;
  assert.ok(width > 0 && height > 0);
  assert.ok(bits?.every((n) => n === 16), `Expected true 16-bit samples; got ${bits}`);
  assert.equal(tags.get(284)?.[0] ?? 1, 1, 'Only chunky TIFF planar layout is supported by acceptance decoder');
  const sampleFormat = tags.get(339) ?? [1];
  assert.ok(sampleFormat.every((n) => n === 1), 'Expected unsigned integer samples');
  const compression = tags.get(259)?.[0] ?? 1;
  assert.ok([1, 8, 32946].includes(compression), `Unsupported TIFF compression ${compression}`);
  const offsets = tags.get(273), lengths = tags.get(279);
  assert.ok(offsets && lengths && offsets.length === lengths.length, 'Expected TIFF strip offsets and lengths');
  const predictor = tags.get(317)?.[0] ?? 1;
  assert.ok([1, 2].includes(predictor), `Unsupported TIFF predictor ${predictor}`);
  const distinct = new Set();
  let samples = 0, nonReplicatedSamples = 0;
  for (let strip = 0; strip < offsets.length; strip += 1) {
    const offset = offsets[strip], length = lengths[strip];
    assert.ok(offset + length <= bytes.length, 'TIFF strip exceeds file bounds');
    const encoded = bytes.subarray(offset, offset + length);
    const raster = compression === 1 ? encoded : inflateSync(encoded);
    const row = new Uint16Array(width * channels);
    for (let i = 0; i + 1 < raster.length; i += 2) {
      const x = (i / 2) % row.length;
      let value = little ? raster.readUInt16LE(i) : raster.readUInt16BE(i);
      if (predictor === 2 && x >= channels) value = (value + row[x - channels]) & 65535;
      row[x] = value;
      if (value % 257 !== 0) nonReplicatedSamples += 1;
      distinct.add(value);
      samples += 1;
    }
  }
  assert.equal(samples, width * height * channels, 'Decoded sample count must cover the entire image');
  assert.ok(nonReplicatedSamples > 0, 'All TIFF pixels were 8-bit values multiplied by 257');
  return { width, height, channels, bit_depth: 16, compression, unique_values: distinct.size, samples, non_8bit_replicated_samples: nonReplicatedSamples };
}
