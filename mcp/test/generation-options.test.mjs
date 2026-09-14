import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../dist/tools.js';

const retouch = toolDefinitions.find((tool) => tool.method === 'retouch');
const base = { session_id: 'session', mode: 'generative', prompt: 'Remove target', sub_masks: [{id:'mask',type:'radial',visible:true,mode:'additive',parameters:{}}] };

test('generative schema preserves explicit options and retains the omitted default contract', () => {
  const options = {seed:Number.MAX_SAFE_INTEGER,profile:'balanced-v1',megapixels:2};
  assert.deepEqual(retouch.schema.parse({...base,generation_options:options}).generation_options,options);
  assert.equal(retouch.schema.parse(base).generation_options,undefined);
});

test('generative schema rejects unsafe seeds, unsupported option keys and malformed profile/resolution values', () => {
  for (const options of [{seed:0},{seed:1.5},{seed:Number.MAX_SAFE_INTEGER+1},{seed:null},{profile:'../model'},{profile:' x'},{profile:'x'.repeat(65)},{megapixels:NaN},{megapixels:Infinity},{megapixels:0},{megapixels:17},{workflow:{}}]) {
    assert.throws(() => retouch.schema.parse({...base,generation_options:options}));
  }
});
