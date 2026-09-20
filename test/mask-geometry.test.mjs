import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-mask-geometry-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const output = join(directory, 'mask-geometry.mjs');
await build({
  stdin: {
    contents: 'export { transformMaskGeometryForSpatialChange } from "./src/utils/maskGeometry";',
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
});

const { transformMaskGeometryForSpatialChange } = await import(pathToFileURL(output));

const spatial = (overrides = {}) => ({
  rotation: 0,
  orientationSteps: 0,
  flipHorizontal: false,
  flipVertical: false,
  ...overrides,
});

test('clockwise rotation carries coordinate masks and clone source points with the image', () => {
  const masks = [
    {
      id: 'm',
      subMasks: [
        {
          id: 'radial',
          type: 'radial',
          parameters: { centerX: 20, centerY: 10, radiusX: 8, radiusY: 4, rotation: 15 },
        },
        {
          id: 'brush',
          type: 'brush',
          parameters: {
            lines: [
              {
                points: [
                  { x: 5, y: 6 },
                  { x: 15, y: 16 },
                ],
              },
            ],
          },
        },
        {
          id: 'clone',
          type: 'clone',
          parameters: { lines: [{ points: [{ x: 30, y: 20 }] }], sourceX: 40, sourceY: 25 },
        },
      ],
    },
  ];
  const result = transformMaskGeometryForSpatialChange(masks, [], 100, 60, spatial(), spatial({ orientationSteps: 1 }));

  assert.deepEqual(result.masks[0].subMasks[0].parameters, {
    centerX: 50,
    centerY: 20,
    radiusX: 8,
    radiusY: 4,
    rotation: 105,
  });
  assert.deepEqual(result.masks[0].subMasks[1].parameters.lines[0].points, [
    { x: 54, y: 5 },
    { x: 44, y: 15 },
  ]);
  assert.deepEqual(result.masks[0].subMasks[2].parameters, {
    lines: [{ points: [{ x: 40, y: 30 }] }],
    sourceX: 35,
    sourceY: 40,
  });
  assert.deepEqual(masks[0].subMasks[0].parameters.centerX, 20);
});

test('source-backed masks keep their source selection and receive the new display transform', () => {
  const masks = [
    {
      id: 'm',
      subMasks: [
        {
          id: 'subject',
          type: 'ai-subject',
          parameters: {
            maskDataBase64: 'saved-mask',
            startX: 20,
            startY: 10,
            endX: 40,
            endY: 30,
            rotation: 4,
            orientationSteps: 0,
          },
        },
        {
          id: 'colour',
          type: 'color',
          parameters: { targetX: 20, targetY: 10, rotation: 4, orientationSteps: 0 },
        },
      ],
    },
  ];
  const result = transformMaskGeometryForSpatialChange(masks, [], 100, 60, spatial(), spatial({ orientationSteps: 1 }));

  assert.deepEqual(result.masks[0].subMasks[0].parameters, {
    maskDataBase64: 'saved-mask',
    startX: 50,
    startY: 20,
    endX: 30,
    endY: 40,
    rotation: 0,
    orientationSteps: 1,
    flipHorizontal: false,
    flipVertical: false,
  });
  assert.deepEqual(result.masks[0].subMasks[1].parameters, {
    targetX: 20,
    targetY: 10,
    rotation: 0,
    orientationSteps: 1,
    flipHorizontal: false,
    flipVertical: false,
  });
});
