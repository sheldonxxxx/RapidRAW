import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-surface-editing-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const stubs = {
  react: `export const useState = value => [typeof value === 'function' ? value() : value, () => {}];
    export const useRef = current => ({ current }); export const useEffect = () => {};`,
  'react/jsx-runtime': `export const Fragment = 'Fragment'; export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;`,
  'react-i18next': `export const useTranslation = () => ({ t: (key, options) => options?.defaultValue ?? key });`,
  '../../../hooks/useAiMasking': `export const discardMarigoldResult = () => {}; export const isMarigoldPending = () => false;`,
  '../../../store/useEditorStore': `export const useEditorStore = fn => fn({ isGeneratingAiMask: false, adjustments: { masks: [] } });`,
  '../../ui/Slider': `export default 'Slider';`,
};
const output = join(directory, 'editing.mjs');
await build({
  stdin: {
    contents: `export * from './src/utils/surfaceEditing';
      export { default as SurfaceControls } from './src/components/panel/right/MarigoldSurfaceControls';
      export { default as DepthControls } from './src/components/panel/right/MarigoldDepthControls';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'ui-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      },
    },
  ],
});
const { photoPointToSurface, surfacePointToPhoto, displayedLightDirection, SurfaceControls, DepthControls } =
  await import(pathToFileURL(output));
const identity = { rotation: 0, orientationSteps: 0, flipHorizontal: false, flipVertical: false };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
function button(tree, label) {
  return elements(tree).find((node) => node.type === 'button' && node.props.children === label);
}

test('photograph picking reverses clockwise orientation, crop offset and zoom without undoing lens geometry', () => {
  // Source (200,150) in an 800x600 analysed frame becomes (450,200) after a clockwise quarter turn.
  // A crop beginning at (100,50), displayed at half size, puts it at stage (175,75).
  const point = photoPointToSurface({ x: 175 / 0.5 + 100, y: 75 / 0.5 + 50 }, 800, 600, {
    ...identity,
    orientationSteps: 1,
    transformHorizontal: 25,
  });
  assert.deepEqual(point, { x: 0.25, y: 0.25 });
});
test('sample markers and picks remain attached through every orientation, both flips and fine rotation', () => {
  for (const orientationSteps of [0, 1, 2, 3])
    for (const flipHorizontal of [false, true])
      for (const flipVertical of [false, true])
        for (const rotation of [-17, 0, 23]) {
          const orientation = { orientationSteps, flipHorizontal, flipVertical, rotation };
          for (const sample of [
            { x: 0.25, y: 0.37 },
            { x: 0.5, y: 0.5 },
            { x: 0.75, y: 0.62 },
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ]) {
            const display = surfacePointToPhoto(sample, 800, 600, orientation);
            const result = photoPointToSurface(display, 800, 600, orientation);
            assert.ok(result);
            close(result.x, sample.x);
            close(result.y, sample.y);
          }
        }
});
test('empty geometry and clicks in rotated padding do not silently select an edge colour', () => {
  assert.equal(photoPointToSurface({ x: 1, y: 1 }, 0, 600, identity), null);
  assert.equal(photoPointToSurface({ x: -1, y: 300 }, 800, 600, identity), null);
  assert.equal(photoPointToSurface({ x: 0, y: 0 }, 800, 600, { ...identity, rotation: 30 }), null);
});
test('negative saved light strengths display the equivalent positive direction', () => {
  for (const angle of [-180, -90, 0, 45, 90, 180]) {
    const direction = displayedLightDirection(angle, -0.4);
    for (const [x, y] of [
      [1, 0],
      [0, 1],
      [0.6, 0.8],
    ]) {
      const dot = (degrees) => x * Math.cos((degrees * Math.PI) / 180) + y * Math.sin((degrees * Math.PI) / 180);
      close(-0.4 * dot(angle), 0.4 * dot(direction));
    }
  }
});
test('light direction and strength controls update existing recipe parameters without regenerating analysis', () => {
  const parameters = {
    surfaceArtifact: { geometryHash: 'saved' },
    maskDataBase64: 'saved-map',
    normalAngle: 0,
    normalAmount: -0.4,
    feather: 12,
  };
  const updates = [];
  let generated = 0;
  let brushes = 0;
  const tree = SurfaceControls({
    subMask: { id: 'light', type: 'ai-normals', parameters },
    enabled: false,
    generate: () => generated++,
    updateSubMask: (id, value) => updates.push({ id, ...value }),
    onDragStateChange() {},
    onLimitWithBrush: () => brushes++,
  });
  assert.equal(button(tree, 'Left').props['aria-pressed'], true);
  button(tree, 'Above').props.onClick();
  assert.deepEqual(updates[0], { id: 'light', parameters: { ...parameters, normalAngle: 90, normalAmount: 0.4 } });
  elements(tree)
    .find((node) => node.type === 'Slider' && node.props.label === 'Strength')
    .props.onChange({ target: { value: '0' } });
  assert.equal(updates[1].parameters.normalAmount, 0);
  assert.equal(updates[1].parameters.maskDataBase64, 'saved-map');
  button(tree, 'Limit with a brush').props.onClick();
  assert.equal(brushes, 1);
  assert.equal(generated, 0);
});
test('depth starting selections are ordered near-to-far, keep saved assets and work offline', () => {
  const parameters = {
    depthProvider: 'marigold',
    depthArtifact: { mapHash: 'saved' },
    maskDataBase64: 'saved-map',
    feather: 8,
  };
  const updates = [];
  let generated = 0;
  const tree = DepthControls({
    subMask: { id: 'depth', parameters },
    enabled: false,
    generate: () => generated++,
    updateSubMask: (id, value) => updates.push(value.parameters),
  });
  for (const name of ['Near', 'Middle', 'Far']) button(tree, name).props.onClick();
  assert.deepEqual(
    updates.map((p) => [p.minDepth, p.maxDepth]),
    [
      [65, 100],
      [30, 70],
      [0, 35],
    ],
  );
  for (const p of updates) {
    assert.equal(p.depthArtifact, parameters.depthArtifact);
    assert.equal(p.maskDataBase64, 'saved-map');
    assert.equal(p.feather, 8);
  }
  assert.equal(generated, 0);
});
