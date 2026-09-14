import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoIccWarnings, inspectDisplaySrgbProfile } from '../scripts/icc-inspect.mjs';

// Synthetic tag-table fixture for parser failure paths, not a usable photo profile.
function profileFixture() {
  const d50 = [0.9642, 1, 0.8249],
    d65 = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329];
  const payloads = [
    ['wtpt', 'XYZ ', d50],
    ['rXYZ', 'XYZ ', [0.436, 0.2225, 0.0139]],
    ['gXYZ', 'XYZ ', [0.3851, 0.7169, 0.0971]],
    ['bXYZ', 'XYZ ', [d50[0] - 0.436 - 0.3851, 1 - 0.2225 - 0.7169, d50[2] - 0.0139 - 0.0971]],
    ['chad', 'sf32', [d50[0] / d65[0], 0, 0, 0, 1, 0, 0, 0, d50[2] / d65[2]]],
  ];
  let offset = 132 + payloads.length * 12;
  const bytes = Buffer.alloc(offset + payloads.reduce((sum, tag) => sum + 8 + tag[2].length * 4, 0));
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('mntr', 12);
  bytes.write('RGB ', 16);
  bytes.write('XYZ ', 20);
  bytes.write('acsp', 36);
  d50.forEach((value, i) => bytes.writeInt32BE(Math.round(value * 65536), 68 + i * 4));
  bytes.writeUInt32BE(payloads.length, 128);
  payloads.forEach(([name, type, values], i) => {
    const entry = 132 + i * 12,
      size = 8 + values.length * 4;
    bytes.write(name, entry);
    bytes.writeUInt32BE(offset, entry + 4);
    bytes.writeUInt32BE(size, entry + 8);
    bytes.write(type, offset);
    values.forEach((value, j) => bytes.writeInt32BE(Math.round(value * 65536), offset + 8 + j * 4));
    offset += size;
  });
  return bytes;
}

test('independent ICC parser rejects wrong D50, unaligned tags, truncated profiles and inconsistent white', () => {
  assert.equal(inspectDisplaySrgbProfile(profileFixture()).all_tag_offsets_aligned, true);
  const white = profileFixture();
  white.writeUInt32BE(63171, 68);
  assert.throws(() => inspectDisplaySrgbProfile(white), /specified D50/);
  const unaligned = profileFixture();
  unaligned.writeUInt32BE(unaligned.readUInt32BE(136) + 1, 136);
  assert.throws(() => inspectDisplaySrgbProfile(unaligned), /four-byte aligned/);
  assert.throws(() => inspectDisplaySrgbProfile(profileFixture().subarray(0, 200)), /size must match/);
  const colorant = profileFixture();
  colorant.writeInt32BE(0, colorant.readUInt32BE(148) + 8);
  assert.throws(() => inspectDisplaySrgbProfile(colorant), /summed RGB white/);
});

test('independent decoder ICC warnings fail while absent EXIF warnings remain allowed', () => {
  assertNoIccWarnings('magick: unknown image property "%[EXIF:GPSLatitude]"');
  for (const warning of [
    'iCCP: PCS illuminant is not D50',
    'ICC profile tag start not a multiple of 4',
    'LCMS: invalid profile',
    'Known incorrect sRGB profile',
  ])
    assert.throws(() => assertNoIccWarnings(warning), /ICC\/colorimetry warning/);
});
