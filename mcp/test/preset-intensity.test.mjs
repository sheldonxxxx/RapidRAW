import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../src/utils/presetIntensity.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { applyPresetIntensity } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);

const base = () => ({
  exposure: 0.8,
  temperature: -3,
  tint: 4,
  colorNoiseReduction: 22,
  sharpness: 17,
  contrast: 10,
  lutPath: null,
  lutIntensity: 100,
  lutIsSceneReferred: false,
  curves: {
    luma: [
      { x: 0, y: 0 },
      { x: 128, y: 136 },
      { x: 255, y: 255 },
    ],
  },
  masks: [],
});
const film = () => ({ lutPath: '/example/film.cube', lutIntensity: 65, lutIsSceneReferred: true, contrast: -4 });

test('partial film presets preserve omitted base corrections and restore zero exactly', () => {
  const captured = base(),
    preset = film(),
    untouched = structuredClone(captured);
  let current = captured;
  for (const intensity of [100, 50, 0, 25, 100]) {
    current = applyPresetIntensity(preset, intensity, captured, current);
    for (const key of ['exposure', 'temperature', 'tint', 'colorNoiseReduction', 'sharpness', 'curves', 'masks']) {
      assert.deepEqual(current[key], captured[key], `${key} at ${intensity}%`);
    }
    if (intensity === 0) assert.deepEqual(current, captured);
    else {
      assert.equal(current.contrast, 10 + ((-4 - 10) * intensity) / 100);
      assert.equal(current.lutIntensity, (65 * intensity) / 100);
      assert.equal(current.lutPath, preset.lutPath);
    }
  }
  assert.deepEqual(captured, untouched);
  assert.deepEqual(current, { ...captured, ...preset });
});

test('changing intensity leaves subsequent edits to omitted controls intact', () => {
  const captured = base(),
    preset = film();
  const edited = { ...applyPresetIntensity(preset, 100, captured), exposure: 1.2, colorNoiseReduction: 30 };
  const half = applyPresetIntensity(preset, 50, captured, edited);
  assert.equal(half.exposure, 1.2);
  assert.equal(half.colorNoiseReduction, 30);
  assert.deepEqual(applyPresetIntensity(preset, 0, captured, half), captured);
});

test('replacing a LUT selects the preset dependency and interpolates one scalar strength', () => {
  const captured = { ...base(), lutPath: '/example/old.cube', lutIntensity: 80 };
  const preset = { ...film(), lutIntensity: 60 };
  const half = applyPresetIntensity(preset, 50, captured);
  assert.equal(half.lutPath, preset.lutPath);
  assert.equal(half.lutIsSceneReferred, true);
  assert.equal(half.lutIntensity, 70);
  assert.deepEqual(applyPresetIntensity(preset, 0, captured, half), captured);
});

test('full presets retain exact 100 percent values and blend from the captured edit', () => {
  const captured = base();
  const preset = { ...base(), exposure: -0.4, temperature: 7, contrast: 30, sharpness: 40 };
  assert.deepEqual(applyPresetIntensity(preset, 100, captured), preset);
  const half = applyPresetIntensity(preset, 50, captured);
  assert.ok(Math.abs(half.exposure - 0.2) < 1e-12);
  assert.equal(half.temperature, 2);
  assert.equal(half.contrast, 20);
  assert.equal(half.sharpness, 28.5);
  assert.deepEqual(applyPresetIntensity(preset, 0, captured, half), captured);
});

test('curves interpolate at common coordinates and noncurve arrays keep their topology', () => {
  const captured = base();
  const preset = {
    curves: {
      luma: [
        { x: 0, y: 6 },
        { x: 64, y: 72 },
        { x: 255, y: 249 },
      ],
    },
    masks: [{ id: 'selected-mask' }],
  };
  const half = applyPresetIntensity(preset, 50, captured);
  assert.deepEqual(
    half.curves.luma.map((point) => point.x),
    [0, 64, 128, 255],
  );
  assert.equal(half.curves.luma[0].y, 3);
  assert.equal(half.curves.luma[1].y, 70);
  assert.equal(half.curves.luma[3].y, 252);
  assert.deepEqual(half.masks, preset.masks);
  assert.deepEqual(applyPresetIntensity(preset, 100, captured).curves, preset.curves);
  assert.deepEqual(applyPresetIntensity(preset, 0, captured, half), captured);
});
