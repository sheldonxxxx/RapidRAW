import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelOutput,
  capabilityOutput,
  redactClientData,
  summarizeOutput,
  rejectAssetDescriptors,
  resolveAssetDescriptors,
} from '../dist/model-output.js';
import { toolResult } from '../dist/server.js';

function maskedState() {
  return {
    session_id: 'photo',
    revision: 8,
    warnings: ['Inspect feather detail'],
    adjustments: {
      exposure: 0.3,
      lensBlurDepthMap: 'DEPTH'.repeat(10000),
      lutData: 'LUT'.repeat(10000),
      masks: [
        {
          id: 'bird',
          visible: true,
          opacity: 80,
          adjustments: { exposure: 0.4 },
          subMasks: [
            {
              id: 'subject',
              type: 'ai-subject',
              parameters: {
                startX: 20,
                startY: 30,
                maskDataBase64: 'MASK'.repeat(10000),
                samRefinement: {
                  version: 1,
                  canvasWidth: 6000,
                  canvasHeight: 4000,
                  logitsBase64: 'A'.repeat(349528),
                  sourceSha256: 'source',
                },
              },
            },
          ],
        },
      ],
      aiPatches: [
        {
          id: 'repair',
          patchData: {
            color: 'COLOR'.repeat(10000),
            mask: 'REPAIR'.repeat(10000),
            width: 128,
            height: 96,
            generation: { provider: 'connector', seed: 42 },
          },
        },
      ],
    },
  };
}

test('native state assets stay intact while all model-facing paths omit encoded pixels and tensors', () => {
  const native = maskedState();
  const original = structuredClone(native);
  const response = toolResult(native);
  assert.deepEqual(native, original);
  assert.ok(response.content[0].text.length < 4000);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  const data = response.structuredContent;
  assert.equal(data.state_representation.omitted_assets, 6);
  assert.equal(data.adjustments.masks[0].subMasks[0].parameters.samRefinement.canvasWidth, 6000);
  assert.equal(data.adjustments.masks[0].subMasks[0].parameters.maskDataBase64._rapidraw_asset, true);
  assert.equal(data.adjustments.aiPatches[0].patchData.generation.seed, 42);
  assert.deepEqual(data.warnings, native.warnings);
  assert.throws(() => rejectAssetDescriptors({ patch: data.adjustments }), /replacement recipe/);
  assert.doesNotThrow(() => rejectAssetDescriptors({ patch: { exposure: 0.6 }, expected_revision: 8 }));
  assert.equal(modelOutput({ result: native }).result.adjustments.lensBlurDepthMap._rapidraw_asset, true);
});

test('preview bytes and variant associations survive response projection unchanged', () => {
  const native = {
    ...maskedState(),
    images: [
      { label: 'Reference', version_id: 'accepted', data: 'YWJj', mimeType: 'image/png', width: 100, height: 75 },
      {
        label: 'Warmer',
        variant: { patch: { temperature: 4 } },
        data: 'ZGVm',
        mimeType: 'image/png',
        width: 100,
        height: 75,
      },
    ],
  };
  const result = toolResult(native);
  native.images.forEach((image, i) => {
    const meta = result.structuredContent.images[i];
    assert.equal(meta.label, image.label);
    assert.equal(result.content[meta.content_index].data, image.data);
    assert.equal(meta.width, image.width);
    assert.equal(meta.data, undefined);
  });
});

test('selective schemas retain constraints, coordinates and identity; legacy full discovery still works', () => {
  const caps = {
    protocol_version: 1,
    bridge_version: '1.2.0',
    coordinate_space: { masks: 'source pixels' },
    adjustment_schema: {
      type: 'object',
      description: 'Native relative units',
      properties: {
        temperature: { type: 'number', minimum: -100, maximum: 100 },
        masks: { type: 'array', maxItems: 32 },
      },
      default: { temperature: 0, masks: [] },
    },
  };
  const full = capabilityOutput(caps);
  const overview = capabilityOutput(caps, { detail: 'overview' });
  const partial = capabilityOutput(caps, { schema_paths: ['properties.temperature'] });
  assert.deepEqual(full.adjustment_schema, caps.adjustment_schema);
  assert.equal(overview.adjustment_schema, undefined);
  assert.equal(partial.schema_id, full.schema_id);
  assert.deepEqual(partial.schemas['properties.temperature'], caps.adjustment_schema.properties.temperature);
  assert.deepEqual(partial.coordinate_space, caps.coordinate_space);
  assert.equal(partial.schema_description, 'Native relative units');
  assert.throws(() => capabilityOutput(caps, { schema_paths: ['properties.typo'] }), /Unknown adjustment schema path/);
  assert.throws(() => capabilityOutput(caps, { schema_paths: ['__proto__'] }), /Unknown adjustment schema path/);
  assert.notEqual(capabilityOutput({ ...caps, adjustment_schema: {} }).schema_id, full.schema_id);
});

test('compact client keeps lifecycle, refinement, export and failure information, including unknown fields', () => {
  for (const method of [
    'start_denoise',
    'get_job',
    'get_operation_job',
    'save_version',
    'render_compare',
    'export',
    'batch_export',
  ]) {
    const data = {
      job_id: 'job',
      status: 'completed',
      result_session_id: 'derived',
      version_id: 'baseline',
      warnings: ['detail check'],
      images: [{ label: 'A', content_index: 1 }],
      path: '/exports/final.jpg',
      color_profile: { verified: true },
      metadata: { copied: true },
    };
    assert.deepEqual(summarizeOutput(method, data), data);
  }
  const mutation = {
    session_id: 's',
    revision: 9,
    metadata: { exif: 'repeated' },
    mask_id: 'm',
    refinement: { retained: true },
    generation: { seed: 42 },
    future_receipt: { complete: true },
    warnings: ['review'],
  };
  const brief = summarizeOutput('mask_update', mutation);
  assert.equal(brief.metadata, undefined);
  assert.deepEqual(brief.future_receipt, mutation.future_receipt);
  assert.deepEqual(brief.refinement, mutation.refinement);
  const failed = {
    ok: false,
    failed: 1,
    results: [{ ok: true, path: '/exports/ok.jpg' }],
    recovery: { retry_mutation: false },
  };
  assert.deepEqual(summarizeOutput('export', failed), failed);
  const redacted = redactClientData({ ...maskedState(), token: 'credential' });
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.adjustments.aiPatches[0].patchData.color._rapidraw_asset, true);
  assert.equal(redacted.adjustments.masks[0].subMasks[0].parameters.samRefinement.logitsBase64._rapidraw_asset, true);
});

test('descriptors round-trip against live session state, then behave as ordinary values', async () => {
  const native = maskedState();
  const shown = toolResult(native).structuredContent;
  const params = {
    session_id: 'photo',
    expected_revision: 8,
    mode: 'merge',
    // Prune the patch list while keeping the mask: the realistic round-trip edit.
    patch: {
      exposure: 0.35,
      aiPatches: [],
      masks: shown.adjustments.masks,
      state_representation: shown.state_representation,
    },
  };
  let fetched = null;
  const resolved = await resolveAssetDescriptors(params, async (sid) => {
    fetched = sid;
    return structuredClone(native);
  });
  assert.equal(fetched, 'photo');
  assert.equal(resolved.state_representation, undefined);
  assert.deepEqual(resolved.patch.masks, native.adjustments.masks);
  assert.deepEqual(resolved.patch.aiPatches, []);
  assert.equal(resolved.patch.exposure, 0.35);
  // The rehydrated patch no longer trips the replacement-recipe guard.
  assert.doesNotThrow(() => rejectAssetDescriptors(resolved));
  // Input was cloned, never mutated in place.
  assert.equal(params.patch.masks[0].subMasks[0].parameters.maskDataBase64._rapidraw_asset, true);
});

test('descriptor resolution needs no fetch without descriptors and rejects stale or sessionless input', async () => {
  let calls = 0;
  const plain = { session_id: 's', patch: { exposure: 0.6 } };
  assert.deepEqual(await resolveAssetDescriptors(plain, async () => (calls++, {})), plain);
  assert.equal(calls, 0);

  const native = maskedState();
  const shown = toolResult(native).structuredContent;
  const stale = structuredClone(native);
  stale.adjustments.masks[0].subMasks[0].parameters.maskDataBase64 += 'rotated';
  const staleCode = (err) =>
    err?.code === 'STALE_DESCRIPTOR' || /STALE_DESCRIPTOR|Unsafe state path/.test(err?.message ?? '');
  await assert.rejects(
    resolveAssetDescriptors({ session_id: 'photo', patch: { masks: shown.adjustments.masks } }, async () =>
      structuredClone(stale),
    ),
    staleCode,
  );
  // Descriptors without session context keep the original rejection.
  await assert.rejects(
    resolveAssetDescriptors({ patch: shown.adjustments }, async () => ({})),
    /replacement recipe/,
  );
  // Path traversal and prototype pollution never resolve.
  const evil = (path) => ({
    session_id: 'photo',
    patch: { masks: [{ parameters: { maskDataBase64: { _rapidraw_asset: true, sha256: 'x', state_path: path } } }] },
  });
  for (const path of ['/__proto__/x', '/constructor/prototype/x', '/adjustments/masks/99/parameters/maskDataBase64']) {
    await assert.rejects(
      resolveAssetDescriptors(evil(path), async () => structuredClone(native)),
      staleCode,
    );
  }
});
