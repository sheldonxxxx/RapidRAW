/** Small manifest/review contract for first-attempt mask observations. */
import assert from 'node:assert/strict';
import { validatePhotoManifest } from './photo-quality-manifest.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const criteria = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every((value) => typeof value === 'string' && value.trim().length > 0);
function rectangle(region, maximum = 100000) {
  assert.ok(
    region && Object.keys(region).sort().join(',') === 'height,width,x,y',
    'Annotation/guide rectangles require exactly x, y, width and height',
  );
  const { x, y, width, height } = region;
  assert.ok(
    [x, y, width, height].every(Number.isInteger) &&
      x >= 0 &&
      y >= 0 &&
      width > 0 &&
      height > 0 &&
      width <= maximum &&
      height <= maximum,
    'Regions must use bounded integer native pixels',
  );
}
export async function validateFreshMaskManifest(manifest) {
  await validatePhotoManifest(manifest);
  const sources = new Set(),
    captures = new Set();
  for (const group of manifest.groups) {
    assert.equal(group.kind, 'ai-mask');
    assert.equal(
      group.partition,
      'fresh-holdout',
      'First attempts must be declared fresh holdouts; corrections are separate regression records',
    );
    assert.equal(group.sources.length, 1);
    assert.ok(
      !sources.has(group.sources[0].sha256) && !captures.has(group.capture_group),
      'Fresh mask cases require distinct originals and capture groups',
    );
    sources.add(group.sources[0].sha256);
    captures.add(group.capture_group);
    const kinds = {
      'person-hair': ['foreground', 'subject'],
      'wildlife-feet-feathers': ['subject'],
      'sky-architecture': ['sky'],
    };
    assert.ok(kinds[group.category]?.includes(group.mask_kind), 'Category and native mask kind must agree');
    assert.ok(criteria(group.review_criteria), 'Explicit nonempty photographic criteria are required');
    assert.ok(
      !('include_points' in group) && !('exclude_points' in group),
      'Fresh baseline uses automatic/region-only masking; prompts belong in optional refinement',
    );
    if (group.mask_kind === 'subject') rectangle(group.region);
    else assert.equal(group.region, undefined, 'Only subject masking uses a guiding region');
    assert.ok(
      Array.isArray(group.annotations) && group.annotations.length >= 3 && group.annotations.length <= 32,
      'Annotate include, exclude and edge regions before inference',
    );
    const ids = new Set(),
      intents = new Set();
    for (const annotation of group.annotations) {
      assert.ok(
        typeof annotation.id === 'string' && idPattern.test(annotation.id) && !ids.has(annotation.id),
        'Annotation IDs must be unique safe names',
      );
      ids.add(annotation.id);
      assert.ok(['include', 'exclude', 'edge'].includes(annotation.intent));
      intents.add(annotation.intent);
      assert.ok(criteria(annotation.criteria), 'Every native region needs explicit manual review criteria');
      rectangle(annotation.region, 2048);
      if (annotation.intent === 'edge') {
        assert.equal(
          annotation.minimum_opacity,
          undefined,
          'Edge quality requires manual boundary review, not an opacity threshold',
        );
        assert.equal(
          annotation.maximum_opacity,
          undefined,
          'Edge quality requires manual boundary review, not an opacity threshold',
        );
      } else {
        const key = annotation.intent === 'include' ? 'minimum_opacity' : 'maximum_opacity';
        assert.ok(
          Number.isFinite(annotation[key]) && annotation[key] >= 0 && annotation[key] <= 1,
          `${key} must be an explicit 0..1 mean-opacity gate`,
        );
        assert.equal(
          annotation[annotation.intent === 'include' ? 'maximum_opacity' : 'minimum_opacity'],
          undefined,
          'Include and exclude gates must match their intent',
        );
      }
    }
    assert.deepEqual([...intents].sort(), ['edge', 'exclude', 'include']);
    if (group.refinement !== undefined) {
      assert.equal(group.mask_kind, 'subject', 'Optional point refinement supports subject masks only');
      const refinement = group.refinement;
      assert.ok(refinement && typeof refinement === 'object' && !Array.isArray(refinement));
      assert.ok(
        Object.keys(refinement).every((key) => ['include_points', 'exclude_points', 'region'].includes(key)),
        'Refinement accepts only point arrays and an optional guiding region',
      );
      let count = 0;
      const points = new Map();
      for (const key of ['include_points', 'exclude_points'])
        if (refinement[key] !== undefined) {
          assert.ok(Array.isArray(refinement[key]));
          count += refinement[key].length;
          for (const point of refinement[key]) {
            assert.ok(
              point &&
                Object.keys(point).sort().join(',') === 'x,y' &&
                [point.x, point.y].every((v) => Number.isFinite(v) && v >= 0),
            );
            const token = `${point.x},${point.y}`;
            assert.ok(!points.has(token) || points.get(token) === key, 'Conflicting point labels are invalid');
            points.set(token, key);
          }
        }
      assert.ok(count > 0 && count <= 64, 'Refinement requires 1..64 explicit points combined');
      if (refinement.region) rectangle(refinement.region);
    }
  }
  return manifest;
}

export function validateNativeAnnotationBounds(group, dimensions) {
  const { width, height } = dimensions;
  for (const region of [...group.annotations.map((a) => a.region), group.region, group.refinement?.region].filter(
    Boolean,
  )) {
    assert.ok(
      region.x + region.width <= width && region.y + region.height <= height,
      'An annotated native region exceeds the opened full-resolution canvas',
    );
  }
  for (const point of [...(group.refinement?.include_points ?? []), ...(group.refinement?.exclude_points ?? [])]) {
    assert.ok(point.x <= width - 1 && point.y <= height - 1, 'Refinement point exceeds the opened native canvas');
  }
}

export function annotationMetrics(annotations, means) {
  return annotations.map((annotation) => {
    const opacity = means[annotation.id];
    assert.ok(
      Number.isFinite(opacity) && opacity >= 0 && opacity <= 1,
      'Every annotation requires measured native coverage',
    );
    const status =
      annotation.intent === 'edge'
        ? 'manual_review_required'
        : annotation.intent === 'include'
          ? opacity >= annotation.minimum_opacity
            ? 'passed'
            : 'failed'
          : opacity <= annotation.maximum_opacity
            ? 'passed'
            : 'failed';
    return { ...annotation, mean_opacity: opacity, quantitative_status: status };
  });
}

export function unreviewedMaskRecord(group, metrics, details) {
  return {
    ...details,
    fixture: group.id,
    category: group.category,
    capture_group: group.capture_group,
    criteria: group.review_criteria,
    status: 'not_reviewed',
    photographic_quality: 'not_reviewed',
    quantitative_status: metrics.some((metric) => metric.quantitative_status === 'failed') ? 'failed' : 'passed',
    metrics,
    note: 'Interior/background opacity checks cover only their annotated regions. Native edge triplets require a separate named review; successful inference or passing probes never approves the complete mask.',
  };
}

export async function readEditableMaskSession(harness, session_id) {
  const { data } = await harness.call('get_session', { session_id, include_adjustments: true });
  assert.equal(data?.session_id, session_id, 'Editable-state capture must identify the requested session');
  assert.ok(
    data.adjustments && typeof data.adjustments === 'object' && !Array.isArray(data.adjustments),
    'Editable-state capture requires complete adjustments, not the default session summary',
  );
  return data;
}
