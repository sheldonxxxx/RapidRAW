/** Real native acceptance for recipes, LUT assets, geometric review and delivery.
 * Uses a small engine-produced photo, preserving it and all installed presets.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const binary = process.env.RAPIDRAW_BINARY;
const source = process.env.RAPIDRAW_TEST_IMAGE;
const workspace = process.env.RAPIDRAW_WORKSPACE ?? resolve('test-output/asset-e2e');
assert.ok(binary && isAbsolute(binary), 'RAPIDRAW_BINARY must be the absolute built fork executable');
assert.ok(source && isAbsolute(source), 'RAPIDRAW_TEST_IMAGE must be an absolute small native photo export');
assert.ok(isAbsolute(workspace));
await mkdir(workspace, { recursive: true });
const stamp = String(Date.now());
const evidence = join(workspace, `${stamp}-asset-evidence.jsonl`);
const records = [], checks = [], skipped = [];
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const originalHash = await hash(source);
const originalSidecar = await readFile(`${source}.rrdata`).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
let client;
const sanitize = (value, key = '') => {
  if (/token|secret|password/i.test(key)) return '[redacted]';
  if (typeof value === 'string' && (/base64/i.test(key) || value.length > 4096)) return `[omitted ${value.length} characters]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name,item]) => [name,sanitize(item,name)]));
  return value;
};
async function connect() {
  client = new Client({ name: 'rapidraw-assets-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--binary', binary, '--workspace', workspace, '--timeout-ms', '300000'], stderr: 'inherit' }));
}
async function call(method, args = {}, expectError = false) {
  const sequence = records.length + 1;
  const started = performance.now();
  console.error(`[asset-e2e ${sequence}] ${method} started`);
  let result;
  try { result = await client.callTool({ name: `rapidraw_${method}`, arguments: args }, { timeout: 300000 }); }
  catch (error) {
    const record = { sequence, method, args: sanitize(args), elapsed_ms: Math.round(performance.now() - started), transport_error: String(error) };
    records.push(record); await appendFile(evidence, `${JSON.stringify(record)}\n`); throw error;
  }
  const data = result.structuredContent;
  assert.ok(data, `${method} must return structured content`);
  const record = sanitize({ sequence, method, args, elapsed_ms: Math.round(performance.now() - started), is_error: !!result.isError, result: data });
  records.push(record); await appendFile(evidence, `${JSON.stringify(record)}\n`);
  console.error(`[asset-e2e ${sequence}] ${method} ${result.isError ? 'ERROR' : 'OK'} ${record.elapsed_ms}ms`);
  assert.equal(!!result.isError, expectError, `${method}: ${JSON.stringify(data)}`);
  return { data, result };
}
async function preview(session_id, label, options = {}) {
  const response = await call('render', { session_id, format: 'png', ...options });
  const block = response.result.content.find((item) => item.type === 'image');
  assert.ok(block?.data);
  const path = join(workspace, `${stamp}-${label}.png`);
  await writeFile(path, Buffer.from(block.data, 'base64'));
  return { ...response, pixels: block.data, path };
}
function check(name, details) { checks.push({ name, ...details }); }
function inspectCube(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const size = Number(lines.find((line) => line.startsWith('LUT_3D_SIZE '))?.split(/\s+/)[1]);
  assert.equal(size, 33);
  const values = lines.filter((line) => /^[-+.\d]/.test(line)).map((line) => line.split(/\s+/).map(Number));
  assert.equal(values.length, 33 ** 3);
  assert.ok(values.every((row) => row.length === 3 && row.every(Number.isFinite)));
  const offGrid = values.flat().filter((value) => Math.abs(value * 255 - Math.round(value * 255)) > 0.001).length;
  assert.ok(offGrid > 1000, 'CUBE output must retain actual values between 8-bit grid levels');
  return { size, samples: values.length, non_8bit_grid_channels: offGrid };
}
// A synthetic visual marker isolates export-watermark behavior from AI generation.
function watermarkPng() {
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name); const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); type.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc32(Buffer.concat([type,data])),out.length-4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(16,4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((32 * 4 + 1) * 16);
  for (let y=0;y<16;y++) for (let x=0;x<32;x++) { const offset=y*129+1+x*4; rows[offset]=255; rows[offset+1]=x<16?255:30; rows[offset+2]=x<16?255:30; rows[offset+3]=255; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
async function inspectExternally(path) {
  try {
    const { stdout, stderr } = await exec(process.env.RAPIDRAW_MAGICK ?? 'magick', ['identify','-format','%w %h\n%[EXIF:Software]\n%[EXIF:GPSLatitude]\n%[EXIF:GPSLongitude]\n',path], { maxBuffer: 1024 * 1024 });
    const lines = stdout.split('\n');
    const [width,height] = lines[0].split(' ').map(Number);
    return { width,height,software:lines[1] ?? '',gps_latitude:lines[2] ?? '',gps_longitude:lines[3] ?? '',diagnostics:stderr.trim() };
  } catch (error) {
    if (path.endsWith('.jxl')) {
      const bytes=await readFile(path);
      if (bytes[0]===0xff && bytes[1]===0x0a) return { raw_jxl_codestream:true,software:'',gps_latitude:'',gps_longitude:'',metadata_verification:'Raw JPEG XL codestream has no metadata container boxes; dimensions are independently decoded by the native jxl-oxide verifier.' };
    }
    skipped.push({ name:'external_metadata_decode', path, reason:String(error) });
    return null;
  }
}
async function assertPixelDifference(first,second) {
  try { await exec(process.env.RAPIDRAW_MAGICK ?? 'magick', ['compare','-metric','AE',first,second,'null:']); assert.fail('Expected visibly different watermark output'); }
  catch (error) {
    if (error.code === 1) { const changed = Number.parseFloat(String(error.stderr).trim()); assert.ok(changed > 0); return changed; }
    throw error;
  }
}
let failure;
try {
  await connect();
  const opened = (await call('open_photo', { path:source, inherit_sidecar:false })).data;
  const session_id = opened.session_id;
  const { width,height } = opened.dimensions;
  assert.ok(width>=300 && height>=300 && Math.max(width,height)<=2048, 'Use a small native photo export with both dimensions >=300');
  const originalState = (await call('get_session', { session_id, include_adjustments:true })).data;
  const suggested = (await call('auto_adjust', { session_id })).data;
  assert.equal(suggested.applied,false);
  assert.equal((await call('get_session', { session_id })).data.revision,originalState.revision);
  const autoApplied = (await call('auto_adjust', { session_id, apply:true, expected_revision:originalState.revision })).data;
  assert.equal(autoApplied.applied,true); assert.ok(autoApplied.revision>originalState.revision);
  await call('undo', { session_id });
  assert.deepEqual((await call('get_session', { session_id, include_adjustments:true })).data.adjustments,originalState.adjustments);
  check('auto_suggestion_apply_undo',{ suggested_keys:Object.keys(suggested.suggestions) });

  await call('set_adjustments', { session_id, patch:{ orientationSteps:1,crop:{unit:'px',x:10,y:20,width:200,height:300},exposure:0.27,contrast:9,vibrance:6 } });
  const cropped = await preview(session_id,'rotated-crop');
  assert.equal(cropped.data.width,200); assert.equal(cropped.data.height,300);
  assert.equal(cropped.data.rendered_width,200); assert.equal(cropped.data.rendered_height,300);
  const roi = await preview(session_id,'native-roi',{ region:{x:15,y:17,width:80,height:90} });
  assert.equal(roi.data.width,80); assert.equal(roi.data.height,90);
  assert.deepEqual(roi.data.coordinates.preview_to_rendered_scale,{x:1,y:1});
  await call('render',{session_id,region:{x:190,y:0,width:20,height:20}},true);
  check('orientation_crop_native_roi',{ crop:[200,300],region:[80,90],region_scale:roi.data.coordinates.preview_to_rendered_scale });
  await call('set_adjustments',{session_id,patch:{orientationSteps:0,crop:null}});

  const recipePath=join(workspace,'recipes',`${stamp}-roundtrip.json`);
  await call('save_recipe',{session_id,path:recipePath});
  const savedRecipe=JSON.parse(await readFile(recipePath,'utf8'));
  const recipePreview=await preview(session_id,'recipe-reference');
  await call('set_adjustments',{session_id,patch:{exposure:-0.4}});
  await call('load_recipe',{session_id,path:recipePath,mode:'replace'});
  const loadedRecipe=(await call('get_session',{session_id,include_adjustments:true})).data.adjustments;
  const normalizeNulls=(value)=>Array.isArray(value)?value.map(normalizeNulls):(value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,item])=>item!==null).map(([key,item])=>[key,normalizeNulls(item)])):value);
  assert.deepEqual(normalizeNulls(loadedRecipe),normalizeNulls(savedRecipe));
  assert.equal((await preview(session_id,'recipe-reloaded')).pixels,recipePreview.pixels);
  check('load_recipe_roundtrip',{path:recipePath});
  const presets=(await call('list_presets')).data.presets;
  if (presets.length) {
    const before=(await call('get_session',{session_id,include_adjustments:true})).data;
    const beforePreset=await preview(session_id,'before-preset');
    const presetApplied=(await call('apply_preset',{session_id,preset_id:presets[0].id,intensity:25})).data;
    assert.notEqual((await preview(session_id,'after-preset')).pixels,beforePreset.pixels,'Applying a nonzero installed preset must change rendered pixels');
    if (presets[0].adjustments.enableNegativeConversion===false) assert.ok(presetApplied.warnings?.some((warning)=>warning.includes('inactive legacy')));
    await call('undo',{session_id});
    assert.deepEqual((await call('get_session',{session_id,include_adjustments:true})).data.adjustments,before.adjustments);
    check('existing_preset_apply_undo',{preset_id:presets[0].id});
  } else skipped.push({name:'existing_preset_apply',reason:'No installed presets available; installed assets were not mutated.'});

  const beforeLocalCurve=await preview(session_id,'before-local-curve');
  const localCurve=(await call('mask_create',{session_id,type:'all',name:'Local point curve verification',parameters:{},adjustments:{curveMode:'point',pointCurves:{luma:[{x:0,y:0},{x:255,y:180}]}}})).data;
  const createdLocalCurve=await preview(session_id,'created-local-curve');
  assert.notEqual(createdLocalCurve.pixels,beforeLocalCurve.pixels,'Local UI point curves must change pixels when the mask is created without explicit native curves');
  await call('mask_update',{session_id,mask_id:localCurve.mask_id,patch:{adjustments:{pointCurves:{luma:[{x:0,y:0},{x:255,y:230}]}}}});
  const updatedLocalCurve=await preview(session_id,'updated-local-curve');
  assert.notEqual(updatedLocalCurve.pixels,createdLocalCurve.pixels,'Updating only local pointCurves must recompile previously generated native curves');
  await call('mask_remove',{session_id,mask_id:localCurve.mask_id});
  assert.equal((await preview(session_id,'removed-local-curve')).pixels,beforeLocalCurve.pixels,'Removing the local curve mask must restore the original rendered pixels');
  check('local_ui_curve_create_update_remove',{created_luma_endpoint:180,updated_luma_endpoint:230,removed_restores_baseline:true});

  const mask=(await call('mask_create',{session_id,type:'radial',name:'Asset verification mask',parameters:{centerX:width/2,centerY:height/2,radiusX:width/4,radiusY:height/4,rotation:0,feather:0.6},adjustments:{exposure:0.15}})).data;
  const cubePath=join(workspace,'exports',`${stamp}-style.cube`);
  const cube=(await call('export',{session_id,path:cubePath,format:'cube'})).data;
  const cubeStats=inspectCube(await readFile(cubePath,'utf8'));
  assert.ok(cube.excluded_adjustments.includes('masks'));
  check('cube_precision_and_spatial_exclusions',{...cubeStats,excluded_adjustments:cube.excluded_adjustments});
  await call('apply_lut',{session_id,path:cubePath,intensity:60});
  const lutState=(await call('get_session',{session_id,include_adjustments:true})).data;
  const ownedLut=lutState.adjustments.lutPath;
  assert.notEqual(ownedLut,cubePath); assert.ok(ownedLut.includes(`/sessions/${session_id}/assets/`));
  assert.equal(await hash(ownedLut),await hash(cubePath));
  const beforeRestart=await preview(session_id,'lut-before-restart');
  const movedCube=cubePath.replace(/\.cube$/, '-moved.cube');
  await rename(cubePath,movedCube);
  await call('save_session',{session_id});
  await client.close(); await connect();
  const restored=(await call('get_session',{session_id,include_adjustments:true})).data;
  assert.equal(restored.adjustments.lutPath,ownedLut);
  assert.equal((await preview(session_id,'lut-after-restart')).pixels,beforeRestart.pixels);
  check('owned_lut_survives_external_move_and_restart',{owned_lut:ownedLut});

  // Exercise inherited source-sidecar assets without touching the user's source.
  const inheritedSource=join(workspace,`${stamp}-inherited-source.jpg`);
  await copyFile(source,inheritedSource);
  const inheritedSidecar={version:1,rating:2,tags:['asset-e2e'],futureEnvelopeField:{preserved:true},adjustments:{lutPath:movedCube,lutIntensity:70}};
  await writeFile(`${inheritedSource}.rrdata`,JSON.stringify(inheritedSidecar));
  const inheritedHash=await hash(`${inheritedSource}.rrdata`);
  const inherited=(await call('open_photo',{path:inheritedSource})).data;
  assert.ok(inherited.adjustments.lutPath.includes(`/sessions/${inherited.session_id}/assets/`));
  await rename(movedCube,`${movedCube}.again`);
  await preview(inherited.session_id,'inherited-lut-after-source-move');
  await call('save_session',{session_id:inherited.session_id});
  assert.equal(await hash(`${inheritedSource}.rrdata`),inheritedHash);
  assert.equal(inherited.metadata.futureEnvelopeField.preserved,true);
  check('source_sidecar_lut_materialization',{session_id:inherited.session_id,source_sidecar_unchanged:true});

  await call('set_metadata',{session_id,exif:{Artist:'RapidRAW MCP asset acceptance'}});
  for (const [format,extension] of [['jpeg','jpg'],['png','png'],['tiff','tiff'],['webp','webp'],['avif','avif'],['jxl','jxl']]) {
    const path=join(workspace,'exports',`${stamp}-format.${extension}`);
    const output=(await call('export',{session_id,path,format,resize:{mode:'width',value:240},keep_metadata:true,strip_gps:true,...(['png','tiff'].includes(format)?{bit_depth:16}:{})})).data;
    assert.equal(output.width,240); assert.equal(output.height,Math.round(height*240/width));
    assert.ok(output.bytes>0 && (await stat(path)).size===output.bytes);
    assert.equal(typeof output.metadata_applied,'boolean');
    if (!output.metadata_applied) assert.ok(output.warnings.some((warning)=>/metadata|EXIF/.test(warning)));
    const external=await inspectExternally(path);
    if (external) {
      if (!external.raw_jxl_codestream) { assert.equal(external.width,output.width);assert.equal(external.height,output.height); }
      assert.equal(external.gps_latitude,'');assert.equal(external.gps_longitude,'');
      assert.equal(output.metadata_applied,external.software.includes('RapidRAW'),`${format}: metadata_applied must match exported Software tag`);
    }
    check(`format_${format}`,{path,metadata_applied:output.metadata_applied,verification:output.verified,external});
  }
  for (const [mode,value,expectedWidth,expectedHeight] of [
    ['height',180,Math.round(width*180/height),180],['longEdge',220,220,Math.round(height*220/width)],['shortEdge',120,Math.round(width*120/height),120],['width',width*2,width,height],
  ]) {
    const output=(await call('export',{session_id,path:join(workspace,'exports',`${stamp}-resize-${mode}.jpg`),format:'jpeg',resize:{mode,value}})).data;
    assert.equal(output.width,expectedWidth);assert.equal(output.height,expectedHeight);
  }
  await call('export',{session_id,path:join(workspace,'exports',`${stamp}-conflict.jpg`),long_edge:100,resize:{mode:'width',value:200}},true);
  check('all_resize_modes_and_conflict',{no_enlargement_default:true});

  const watermarkPath=join(workspace,`${stamp}-watermark.png`);await writeFile(watermarkPath,watermarkPng());
  const plainPath=join(workspace,'exports',`${stamp}-unmarked.png`), markedPath=join(workspace,'exports',`${stamp}-marked.png`);
  await call('export',{session_id,path:plainPath,format:'png',bit_depth:8,resize:{mode:'width',value:320}});
  const marked=(await call('export',{session_id,path:markedPath,format:'png',bit_depth:8,resize:{mode:'width',value:320},watermark:{path:watermarkPath,anchor:'bottomRight',scale:25,spacing:3,opacity:75},export_masks:true})).data;
  assert.equal(marked.masks.length,1);assert.equal(marked.masks[0].mask_id,mask.mask_id);
  assert.ok(marked.masks[0].coverage.nonzero_fraction>0);
  await stat(marked.masks[0].image_path);await stat(marked.masks[0].alpha_path);
  const changedPixels=await assertPixelDifference(plainPath,markedPath);
  check('watermark_pixels_and_selective_exports',{absolute_error_metric:changedPixels,masks:marked.masks});

  await call('export',{session_id,path:join(workspace,'recipes',`${stamp}-wrong-category.jpg`),format:'jpeg'},true);
  await call('save_recipe',{session_id,path:join(workspace,'exports',`${stamp}-wrong-category.json`)},true);
  const protectedPath=join(workspace,'exports',`${stamp}-protected-source.jpg`);await copyFile(source,protectedPath);
  const protectedHash=await hash(protectedPath);
  const protectedSession=(await call('open_photo',{path:protectedPath,inherit_sidecar:false})).data;
  await call('export',{session_id:protectedSession.session_id,path:protectedPath,format:'jpeg',overwrite:true},true);
  assert.equal(await hash(protectedPath),protectedHash);
  check('source_inside_export_category_protected',{source_unchanged:true});
  await call('save_session',{session_id});
} catch (error) { failure=error;throw error; }
finally {
  await client?.close();
  assert.equal(await hash(source),originalHash,'Sample source changed');
  const after=await readFile(`${source}.rrdata`).catch((error)=>{if(error.code==='ENOENT')return null;throw error;});
  assert.deepEqual(after,originalSidecar,'Original sidecar changed');
  const summary={status:failure?'failed':'passed',error:failure?String(failure):undefined,source,source_sha256:originalHash,source_unchanged:true,checks,skipped,calls:records.length};
  await writeFile(join(workspace,`${stamp}-asset-summary.json`),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
}
