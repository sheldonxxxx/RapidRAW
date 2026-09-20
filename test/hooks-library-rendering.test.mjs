import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-library-rendering-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const stubs = {
  'react-i18next':
    'export const useTranslation=()=>({t:(key,options)=>options?.count === undefined ? key : `${key}:${options.count}`});',
  '@dnd-kit/core': 'export const useDraggable=()=>({attributes:{},listeners:{},setNodeRef:()=>{},isDragging:false});',
  '../../../utils/adjustments': 'export const COLOR_LABELS=[];',
  '../../../store/useProcessStore': 'export const useProcessStore=selector=>selector({thumbnails:{}});',
  '../../../store/useSettingsStore': 'export const useSettingsStore=selector=>selector({appSettings:{}});',
  '../../ui/AppProperties':
    'export const ThumbnailAspectRatio={Cover:"cover",Contain:"contain",Justified:"justified"}; export const ExifOverlay={Off:"off",Hover:"hover",Always:"always"};',
};
const output = join(directory, 'library.mjs');
await build({
  stdin: {
    contents: `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {List} from 'react-window';
      import {Row} from './src/components/panel/library/LibraryItems';
      export const renderList = props => renderToStaticMarkup(React.createElement(List, {...props, rowComponent: Row}));
      export const renderRow = props => renderToStaticMarkup(React.createElement(Row, props));`,
    resolveDir: resolve('.'),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' },
  plugins: [
    {
      name: 'library-native-state-fixture',
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
const { renderList, renderRow } = await import(pathToFileURL(output));
const image = (path) => ({
  path,
  rating: 0,
  tags: [],
  exif: null,
  modified: 0,
  is_edited: false,
  is_virtual_copy: false,
  is_cloud_placeholder: false,
  is_raw: true,
  group_id: null,
});
function rowData(rows) {
  return {
    rows,
    activePath: null,
    multiSelectedSet: new Set(),
    onContextMenu() {},
    onImageClick() {},
    onImageDoubleClick() {},
    onImageLoad() {},
    queueThumbnailRequest() {},
    onToggleRecursiveFolder() {},
    onAspectRatioLoaded() {},
    thumbnailAspectRatio: 'cover',
    imageRatings: {},
    baseFolderPath: '/photos',
    itemWidth: 160,
    itemHeight: 100,
    outerPadding: 12,
    gap: 12,
    isListView: false,
    columnWidths: {},
    groupBadgeInfo: null,
  };
}

test('react-window v2 forwards library row data and positions folder and photo rows', () => {
  const props = rowData([
    { type: 'header', path: '/photos/outing', count: 2, isExpanded: true },
    {
      type: 'images',
      images: [image('/photos/outing/first.dng'), image('/photos/outing/second.dng')],
      rowHeight: 100,
      justifiedWidths: [160, 120],
    },
    { type: 'footer' },
  ]);
  const html = renderList({
    rowProps: props,
    rowCount: 3,
    rowHeight: (index) => (index === 0 ? 40 : 112),
    defaultHeight: 500,
    style: { height: 500 },
  });
  assert.match(html, />outing<\/span>/);
  assert.match(html, /first\.dng/);
  assert.match(html, /second\.dng/);
  assert.match(html, /translateY\(52px\)/);
  assert.match(html, /width:160px;height:100px/);
  assert.match(html, /width:120px;height:100px/);
});

test('rows disappearing during a library refresh and footer rows render safely', () => {
  const props = {
    ...rowData([]),
    index: 0,
    style: { height: 100 },
    ariaAttributes: { role: 'listitem', 'aria-posinset': 1, 'aria-setsize': 1 },
  };
  assert.equal(renderRow(props), '');
  assert.equal(renderRow({ ...props, rows: [{ type: 'footer' }] }), '');
});
