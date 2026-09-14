import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTiff16 } from '../scripts/tiff-inspect.mjs';
function fixture(samples) {
  const tags = [
    [256, 4, 1, 2],
    [257, 4, 1, 1],
    [258, 3, 1, 16],
    [259, 3, 1, 1],
    [273, 4, 1, 134],
    [277, 3, 1, 3],
    [278, 4, 1, 1],
    [279, 4, 1, 12],
    [284, 3, 1, 1],
    [339, 3, 1, 1],
  ];
  const output = Buffer.alloc(146);
  output.write('II');
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(8, 4);
  output.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    output.writeUInt16LE(tag, offset);
    output.writeUInt16LE(type, offset + 2);
    output.writeUInt32LE(count, offset + 4);
    output.writeUInt32LE(value, offset + 8);
  });
  samples.forEach((sample, index) => output.writeUInt16LE(sample, 134 + index * 2));
  return output;
}
test('TIFF acceptance decoder reads actual pixel precision and rejects expanded 8-bit output', () => {
  const decoded = inspectTiff16(fixture([32000, 32001, 32002, 32003, 32004, 32005]));
  assert.equal(decoded.samples, 6);
  assert.equal(decoded.unique_values, 6);
  assert.equal(decoded.non_8bit_replicated_samples, 6);
  assert.throws(() => inspectTiff16(fixture([0, 257, 514, 771, 1028, 65535])), /8-bit values multiplied/);
});
test('TIFF acceptance decoder rejects truncated raster rather than trusting 16-bit tags', () => {
  assert.throws(
    () => inspectTiff16(fixture([32000, 32001, 32002, 32003, 32004, 32005]).subarray(0, 140)),
    /exceeds file bounds/,
  );
});
