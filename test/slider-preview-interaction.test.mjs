import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-slider-'));
after(() => rm(directory, { recursive: true, force: true }));
const stubs = {
  react: `export default {};
    export const useState = value => [value, () => {}];
    export const useRef = current => ({current});
    export const useCallback = fn => fn;
    export const useMemo = fn => fn();
    export const useEffect = fn => globalThis.__sliderTest.effects.push(fn);`,
  'react/jsx-runtime': `export const jsx = (type, props) => ({type,props}); export const jsxs = jsx;`,
  'react-i18next': 'export const useTranslation = () => ({t: key => key});',
  './AppProperties': 'export const GLOBAL_KEYS = {};',
};
const output = join(directory, 'slider.mjs');
await build({
  entryPoints: ['src/components/ui/Slider.tsx'],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'slider-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    },
  ],
});
const { default: Slider } = await import(pathToFileURL(output));
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
function fixture(t) {
  const state = { events: [], effects: [], timers: [], listeners: {} };
  globalThis.__sliderTest = state;
  const oldWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (fn) => state.timers.push(fn),
    clearTimeout() {},
  };
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
    globalThis.window = oldWindow;
  });
  const root = Slider({
    label: 'Exposure',
    min: -5,
    max: 5,
    step: 0.01,
    value: 0,
    onDragStateChange: (value) => state.events.push(['drag', value]),
    onChange: (event) => state.events.push(['value', event.target.value]),
  });
  const range = elements(root).find((node) => node.type === 'input' && node.props.type === 'range');
  root.props.ref.current = {
    addEventListener: (name, fn) => {
      state.listeners[name] = fn;
    },
    removeEventListener: (name) => {
      delete state.listeners[name];
    },
  };
  const input = { getBoundingClientRect: () => ({ left: 0, width: 100 }) };
  range.props.ref.current = input;
  const cleanups = state.effects.map((effect) => effect());
  return { ...state, range, input, unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

test('mounting an idle slider does not cancel another control preview', (t) => {
  const { events, unmount } = fixture(t);
  assert.deepEqual(events, []);
  unmount();
  assert.deepEqual(events, []);
});

test('mouse press enables interactive rendering before its first value and unmount releases it', (t) => {
  const { range, input, events, unmount } = fixture(t);
  range.props.onMouseDown({ currentTarget: input, clientX: 60, preventDefault() {} });
  assert.deepEqual(events, [
    ['drag', true],
    ['value', 1],
  ]);
  unmount();
  assert.deepEqual(events.at(-1), ['drag', false]);
});

test('touch scrolling remains idle and a horizontal drag enables previews before changing the value', (t) => {
  const { range, events, unmount } = fixture(t);
  range.props.onTouchStart({ touches: [{ clientX: 50, clientY: 0 }] });
  range.props.onTouchMove({ touches: [{ clientX: 52, clientY: 30 }], cancelable: true, preventDefault() {} });
  assert.deepEqual(events, []);
  range.props.onTouchStart({ touches: [{ clientX: 50, clientY: 0 }] });
  range.props.onTouchMove({ touches: [{ clientX: 70, clientY: 0 }], cancelable: true, preventDefault() {} });
  assert.deepEqual(events, [
    ['drag', true],
    ['value', 2],
  ]);
  unmount();
});

test('Shift-wheel edits enable fast previews until the wheel gesture settles', (t) => {
  const { listeners, timers, events, unmount } = fixture(t);
  listeners.wheel({ shiftKey: true, deltaY: -1, deltaX: 0, preventDefault() {} });
  assert.deepEqual(events, [
    ['drag', true],
    ['value', 0.01],
  ]);
  timers.at(-1)();
  assert.deepEqual(events.at(-1), ['drag', false]);
  unmount();
});
