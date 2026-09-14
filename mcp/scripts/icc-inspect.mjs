/** Independent ICC v4 display-profile checks from ICC.1 and the ICC sRGB registry.
 * https://www.color.org/icc1v42.pdf
 * https://www.color.org/security/malformed/bad-illuminant/
 * https://registry.color.org/rgb-registry/files/sRGB.pdf
 */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

export function assertNoIccWarnings(stderr) {
  assert.doesNotMatch(
    String(stderr),
    /\b(?:iCCP|ICC|LCMS|D50|D65|chromatic)\b|white.?point|tag[^\n]*align|sRGB[^\n]*profile/i,
    `Independent decoder reported an ICC/colorimetry warning: ${stderr}`,
  );
}

export function pngProfile(decoded) {
  const chunks = decoded.chunks.filter((chunk) => chunk.type === 'iCCP');
  assert.equal(chunks.length, 1, 'PNG must contain exactly one embedded ICC profile');
  const data = chunks[0].data;
  const end = data.indexOf(0);
  assert.ok(end > 0 && end <= 79, 'PNG ICC profile name must be valid');
  assert.equal(data[end + 1], 0, 'PNG ICC compression method must be deflate');
  return inflateSync(data.subarray(end + 2), { maxOutputLength: 4 * 1024 * 1024 });
}

export function inspectDisplaySrgbProfile(bytes) {
  assert.ok(bytes.length >= 132, 'ICC header/tag table must be complete');
  assert.equal(bytes.readUInt32BE(0), bytes.length, 'ICC size must match actual bytes');
  assert.equal(bytes.length % 4, 0, 'ICC profile size must be four-byte aligned');
  assert.equal(bytes.toString('ascii', 36, 40), 'acsp');
  assert.equal(bytes.toString('ascii', 12, 16), 'mntr');
  assert.equal(bytes.toString('ascii', 16, 20), 'RGB ');
  assert.equal(bytes.toString('ascii', 20, 24), 'XYZ ');
  const fixed = (at) => bytes.readInt32BE(at) / 65536;
  const d50 = [0.9642, 1, 0.8249];
  const xyz = (at) => [fixed(at), fixed(at + 4), fixed(at + 8)];
  const close = (actual, expected, label) =>
    actual.forEach((value, i) =>
      assert.ok(Math.abs(value - expected[i]) <= 4 / 65536, `${label}[${i}]: ${value} differs from ${expected[i]}`),
    );
  assert.deepEqual(
    [68, 72, 76].map((at) => bytes.readUInt32BE(at)),
    [0xf6d6, 0x10000, 0xd32d],
    'ICC PCS illuminant must use the specified D50 fixed-point values',
  );
  const count = bytes.readUInt32BE(128);
  assert.ok(count > 0 && count <= 128);
  const tableEnd = 132 + count * 12;
  assert.ok(tableEnd <= bytes.length);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12,
      name = bytes.toString('ascii', entry, entry + 4),
      offset = bytes.readUInt32BE(entry + 4),
      length = bytes.readUInt32BE(entry + 8);
    assert.equal(offset % 4, 0, `ICC ${name} payload is not four-byte aligned`);
    assert.ok(
      offset >= tableEnd && length >= 8 && offset + length <= bytes.length,
      `ICC ${name} payload lies outside its profile`,
    );
    assert.ok(!tags.has(name), `Duplicate ICC tag ${name}`);
    tags.set(name, { offset, length });
  }
  const xyzTag = (name) => {
    const tag = tags.get(name);
    assert.ok(tag && tag.length >= 20, `ICC ${name} XYZ tag is missing`);
    assert.equal(bytes.toString('ascii', tag.offset, tag.offset + 4), 'XYZ ');
    return xyz(tag.offset + 8);
  };
  const mediaWhite = xyzTag('wtpt');
  close(mediaWhite, d50, 'media D50 white');
  const colorants = ['rXYZ', 'gXYZ', 'bXYZ'].map(xyzTag);
  close(
    d50.map((_, i) => colorants.reduce((sum, column) => sum + column[i], 0)),
    d50,
    'summed RGB white',
  );
  const chad = tags.get('chad');
  assert.ok(chad && chad.length >= 44, 'ICC chromatic adaptation tag is required');
  assert.equal(bytes.toString('ascii', chad.offset, chad.offset + 4), 'sf32');
  const adaptation = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) => fixed(chad.offset + 8 + 4 * (row * 3 + column))),
  );
  const d65 = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329];
  close(
    adaptation.map((row) => row.reduce((sum, value, i) => sum + value * d65[i], 0)),
    d50,
    'D65 adapted to ICC D50',
  );
  return {
    bytes: bytes.length,
    tag_count: count,
    media_white: mediaWhite,
    colorants,
    adaptation,
    all_tag_offsets_aligned: true,
  };
}
