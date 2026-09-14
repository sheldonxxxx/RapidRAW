import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../scripts/coverage-evidence.mjs';
import {
  validateFreshMaskManifest,
  validateNativeAnnotationBounds,
  annotationMetrics,
  unreviewedMaskRecord,
  readEditableMaskSession,
} from '../scripts/fresh-mask-contract.mjs';

const annotations = () => [
  {
    id: 'inside',
    intent: 'include',
    region: { x: 2, y: 2, width: 8, height: 8 },
    criteria: ['Selected interior remains intact'],
    minimum_opacity: 0.95,
  },
  {
    id: 'background',
    intent: 'exclude',
    region: { x: 40, y: 40, width: 8, height: 8 },
    criteria: ['Separate background remains clear'],
    maximum_opacity: 0.05,
  },
  {
    id: 'boundary',
    intent: 'edge',
    region: { x: 10, y: 10, width: 24, height: 24 },
    criteria: ['Inspect fine edges and adjacent background without inferring completeness from opacity'],
  },
];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rapidraw-fresh-mask-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const groups = [];
  for (const [index, [category, mask_kind]] of [
    ['person-hair', 'foreground'],
    ['wildlife-feet-feathers', 'subject'],
    ['sky-architecture', 'sky'],
  ].entries()) {
    const path = join(directory, `source-${index}`);
    await writeFile(path, `distinct contract fixture ${index}`);
    groups.push({
      id: `case-${index}`,
      kind: 'ai-mask',
      partition: 'fresh-holdout',
      category,
      mask_kind,
      capture_group: `capture-${index}`,
      provenance: 'Procedural manifest-contract fixture; no photographic evidence',
      derived_from_same_image: false,
      sources: [{ path, sha256: await hashFile(path) }],
      review_criteria: ['Review actual native mask boundaries'],
      annotations: annotations(),
      ...(mask_kind === 'subject' ? { region: { x: 0, y: 0, width: 64, height: 64 } } : {}),
    });
  }
  return { version: 1, groups };
}
test('fresh mask manifest covers three independent categories and annotated native bounds', async (t) => {
  const manifest = await fixture(t);
  assert.equal((await validateFreshMaskManifest(manifest)).groups.length, 3);
  for (const group of manifest.groups) validateNativeAnnotationBounds(group, { width: 64, height: 64 });
  const invalid = structuredClone(manifest.groups[0]);
  invalid.annotations[0].region.x = 63;
  assert.throws(() => validateNativeAnnotationBounds(invalid, { width: 64, height: 64 }), /exceeds/);
});
test('fresh cases reject missing/manual-looking annotations and reused captures', async (t) => {
  const manifest = await fixture(t);
  const bad = (change) => {
    const copy = structuredClone(manifest);
    change(copy);
    return validateFreshMaskManifest(copy);
  };
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations.pop();
    }),
    /include, exclude and edge/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations[2].minimum_opacity = 0.5;
    }),
    /manual boundary review/,
  );
  await assert.rejects(
    bad((m) => {
      delete m.groups[0].annotations[0].minimum_opacity;
    }),
    /explicit 0..1/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations[2].criteria = [''];
    }),
    /manual review criteria/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations[2].id = '../escape';
    }),
    /safe names/,
  );
  await assert.rejects(
    bad((m) => {
      delete m.groups[0].annotations[2].id;
    }),
    /safe names/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations[2].id = m.groups[0].annotations[0].id;
    }),
    /safe names/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].annotations[2].region.x = 0.5;
    }),
    /integer native/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[1].capture_group = m.groups[0].capture_group;
    }),
    /distinct originals and capture groups/,
  );
  await assert.rejects(
    bad((m) => {
      m.groups[0].partition = 'regression';
    }),
    /declared fresh holdouts/,
  );
});
test('optional corrections cannot replace baseline prompts or target non-subject masks', async (t) => {
  const manifest = await fixture(t);
  manifest.groups[1].refinement = { include_points: [{ x: 10, y: 12 }], exclude_points: [{ x: 40, y: 42 }] };
  await validateFreshMaskManifest(manifest);
  const invalid = structuredClone(manifest);
  invalid.groups[0].refinement = { include_points: [{ x: 10, y: 12 }] };
  await assert.rejects(validateFreshMaskManifest(invalid), /subject masks only/);
  manifest.groups[1].refinement.session_id = 'unexpected-target';
  await assert.rejects(validateFreshMaskManifest(manifest), /only point arrays/);
  delete manifest.groups[1].refinement.session_id;
  manifest.groups[1].refinement.exclude_points = [{ x: 10, y: 12 }];
  await assert.rejects(validateFreshMaskManifest(manifest), /Conflicting point/);
  manifest.groups[1].refinement.exclude_points = [{ x: 64, y: 12 }];
  assert.throws(() => validateNativeAnnotationBounds(manifest.groups[1], { width: 64, height: 64 }), /point exceeds/);
});
test('perfect interior/background probes never approve boundary or photographic quality', () => {
  const metrics = annotationMetrics(annotations(), { inside: 1, background: 0, boundary: 0.5 });
  const record = unreviewedMaskRecord({ id: 'case', review_criteria: ['Fine-edge quality'] }, metrics, {
    status: 'passed',
    photographic_quality: 'approved',
  });
  assert.equal(record.quantitative_status, 'passed');
  assert.equal(record.status, 'not_reviewed');
  assert.equal(record.photographic_quality, 'not_reviewed');
  assert.equal(record.metrics[2].quantitative_status, 'manual_review_required');
});
test('all failed probe measurements remain available for independent-case reporting', () => {
  const metrics = annotationMetrics(annotations(), { inside: 0.2, background: 0.8, boundary: 1 });
  assert.deepEqual(
    metrics.map((m) => m.quantitative_status),
    ['failed', 'failed', 'manual_review_required'],
  );
  const record = unreviewedMaskRecord({ id: 'case', review_criteria: ['Fine-edge quality'] }, metrics, {});
  assert.equal(record.quantitative_status, 'failed');
  assert.equal(record.status, 'not_reviewed');
  assert.equal(record.metrics.length, 3);
  assert.throws(
    () => annotationMetrics(annotations(), { inside: 1, background: 0 }),
    /requires measured native coverage/,
  );
});

test('editable-state capture requests full adjustments and rejects summary-only evidence', async () => {
  const adjustments = { exposure: 0, masks: [{ id: 'retained-mask', subMasks: [] }] };
  const summary = { session_id: 'existing-session', revision: 1 };
  const harness = {
    call: async (method, args) => {
      assert.equal(method, 'get_session');
      return { data: args.include_adjustments ? { ...summary, adjustments } : summary };
    },
  };
  const captured = await readEditableMaskSession(harness, summary.session_id);
  assert.deepEqual(captured.adjustments, adjustments);
  assert.equal(captured.revision, summary.revision);
  await assert.rejects(
    readEditableMaskSession({ call: async () => ({ data: summary }) }, summary.session_id),
    /complete adjustments/,
  );
  await assert.rejects(readEditableMaskSession(harness, 'different-session'), /requested session/);
});
