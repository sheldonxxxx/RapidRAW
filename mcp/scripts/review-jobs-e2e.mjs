/** Native/MCP acceptance for comparisons, references, falloff and recoverable jobs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createNativeHarness } from './coverage-evidence.mjs';
import { decodePng, pixelDifference } from './png-fixtures.mjs';
const binary=process.env.RAPIDRAW_BINARY, source=process.env.RAPIDRAW_TEST_IMAGE;
assert.ok(binary && isAbsolute(binary) && source && isAbsolute(source), 'Set RAPIDRAW_BINARY and RAPIDRAW_TEST_IMAGE');
const workspace=resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/review-jobs-${Date.now()}`);
await mkdir(workspace,{recursive:true});
const coverageEnabled=process.env.RAPIDRAW_COVERAGE==='1';
const evidence=join(workspace,coverageEnabled?'review-jobs-legacy-evidence.jsonl':'evidence.jsonl');
const hash=async(path)=>createHash('sha256').update(await readFile(path)).digest('hex');
const sourceHash=await hash(source);
const sourceSidecar=await readFile(`${source}.rrdata`).catch((error)=>{if(error.code==='ENOENT')return null;throw error;});
let client,coverage,failure;
async function verified(name,requirements,details,level='native_assertion') { if(coverage) await coverage.check(name,requirements,async()=>details,level); }
async function reconnect() { if(coverage){await coverage.reconnect();client=coverage.client;}else{await client.close();await connect();} }
async function connect() {
  if(coverageEnabled){
    coverage=await createNativeHarness({suite:'review-jobs-regression',workspace,binary,env:{ORT_DYLIB_PATH:process.env.ORT_DYLIB_PATH ?? resolve(binary,'../resources/libonnxruntime.dylib')}});
    client=coverage.client;await coverage.fixture(source,'photographic-review-denoise-input');
    if(sourceSidecar)await coverage.fixture(`${source}.rrdata`,'original-sidecar');
    return;
  }
  client=new Client({name:'rapidraw-review-jobs-e2e',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--binary',binary,'--workspace',workspace],stderr:'inherit',
    env:{...process.env,ORT_DYLIB_PATH:process.env.ORT_DYLIB_PATH ?? resolve(binary,'../resources/libonnxruntime.dylib')}}));
}
async function call(method,args={},error=false) {
  const start=performance.now();
  const result=coverage?(await coverage.call(method,args,{expectError:error})).result:await client.callTool({name:`rapidraw_${method}`,arguments:args},{timeout:300000});
  assert.equal(!!result.isError,error,`${method}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  const data=result.structuredContent;
  const record={method,args,elapsed_ms:Math.round(performance.now()-start),is_error:!!result.isError,data};
  await appendFile(evidence,`${JSON.stringify(record)}\n`);
  console.log(`${method}: ${record.elapsed_ms} ms${error?' (expected error)':''}`);
  return {data,images:result.content.filter((c)=>c.type==='image')};
}
const data=async(method,args={},error=false)=>(await call(method,args,error)).data;
async function waitJob(id,expected='succeeded') {
  const deadline=Date.now()+180000; let last=-1;
  while(Date.now()<deadline) {
    const job=await data('get_job',{job_id:id});
    assert.ok(job.progress_percent>=last,'progress cannot regress within an attempt'); last=job.progress_percent;
    if(!['running','cancelling'].includes(job.status)) { assert.equal(job.status,expected,JSON.stringify(job));return job; }
    await new Promise((r)=>setTimeout(r,500));
  }
  assert.fail(`Job ${id} did not terminate`);
}
try {
  await connect();
  const caps=await data('capabilities');
  assert.equal((await client.listTools()).tools.length,caps.methods.length,'Tool count must match live capabilities');
  for(const m of ['inspect_adjustments','render_compare','save_version','start_denoise','cancel_job','resume_job']) assert.ok(caps.methods.includes(m));
  const large=await data('open_photo',{path:source,inherit_sidecar:false});
  await data('export',{session_id:large.session_id,path:'small.png',format:'png',bit_depth:16,long_edge:512});
  const opened=await data('open_photo',{path:join(workspace,'exports','small.png'),inherit_sidecar:false});
  const sid=opened.session_id; const {width,height}=opened.dimensions;
  const mask=await data('mask_create',{session_id:sid,type:'linear',name:'Sky transition',parameters:{startX:0,startY:height/2,endX:width,endY:height/2,range:80},adjustments:{exposure:-0.5}});
  const before=await data('get_session',{session_id:sid,include_adjustments:true});
  const version=await data('save_version',{session_id:sid,label:'Accepted reference',expected_revision:before.revision});
  await data('save_session',{session_id:sid});
  const manifest=join(workspace,'sessions',sid,'session.json'),sidecar=`${before.working_path}.rrdata`;
  const unchanged=[await hash(manifest),await hash(sidecar),await hash(before.working_path)];
  const variants=[{label:'Reference',version_id:version.version_id},{label:'Cooler',patch:{temperature:-15}},{label:'Warmer',patch:{temperature:15}},{label:'Mask off',disabled_masks:[mask.mask_id]}];
  const comparison=await call('render_compare',{session_id:sid,variants,region:{x:0,y:0,width,height},long_edge:512});
  assert.equal(comparison.images.length,4); assert.equal(comparison.data.saved_revision,before.revision);
  for(let i=0;i<4;i++) {
    assert.equal(comparison.data.images[i].data,undefined);
    assert.equal(comparison.data.images[i].content_index,i+1);
    assert.equal(comparison.data.images[i].width,width);
    await writeFile(join(workspace,`comparison-${i}.png`),Buffer.from(comparison.images[i].data,'base64'));
  }
  assert.equal(new Set(comparison.images.map((b)=>b.data)).size,4,'Real alternatives must change pixels');
  const comparedPixels=comparison.images.map((block)=>decodePng(Buffer.from(block.data,'base64')));
  for(const alternative of comparedPixels.slice(1))assert.ok(pixelDifference(comparedPixels[0],alternative).maximum>0,'Decoded comparison alternatives must change pixels');
  await verified('temporary_comparisons_change_decoded_pixels',['tool:render_compare'],{variants:4,saved_revision:before.revision},'pixel_assertion');
  const diagnostic=await call('inspect_adjustments',{session_id:sid,long_edge:512});
  assert.equal(diagnostic.images.length,4); assert.ok(diagnostic.data.exposure_map.min_ev<0);
  for(let i=0;i<4;i++) await writeFile(join(workspace,`inspection-${i}.png`),Buffer.from(diagnostic.images[i].data,'base64'));
  assert.deepEqual([await hash(manifest),await hash(sidecar),await hash(before.working_path)],unchanged);
  assert.deepEqual(await data('get_session',{session_id:sid,include_adjustments:true}),before);
  await verified('diagnostic_maps_leave_manifest_sidecar_source_and_state_unchanged',['tool:inspect_adjustments','tool:render_compare'],{min_ev:diagnostic.data.exposure_map.min_ev,immutable_hashes:unchanged});
  await data('render_compare',{session_id:sid,variants:[{label:'same'},{label:'warped',patch:{transformVertical:10}}]},true);
  await data('render_compare',{session_id:sid,variants:[{label:'same'},{label:'missing',disabled_masks:['missing']}]},true);
  const sub=before.adjustments.masks[0].subMasks[0];
  await data('mask_update',{session_id:sid,mask_id:mask.mask_id,patch:{subMasks:[{...sub,parameters:{...sub.parameters,fadeBefore:40,fadeAfter:120,falloff:'smootherstep'}}]}});
  const smooth=await call('render',{session_id:sid,mask_id:mask.mask_id,long_edge:512,format:'png'});
  await writeFile(join(workspace,'asymmetric-mask.png'),Buffer.from(smooth.images[0].data,'base64'));
  for(let i=0;i<34;i++) await data('set_adjustments',{session_id:sid,patch:{exposure:i%2?0.1:0.2}});
  assert.equal((await data('history',{session_id:sid})).entries.length,32);
  assert.ok((await data('list_versions',{session_id:sid})).versions.some((v)=>v.version_id===version.version_id));
  const edited=await data('get_session',{session_id:sid});
  const restored=await data('restore_version',{session_id:sid,version_id:version.version_id,expected_revision:edited.revision});
  assert.equal(restored.revision,edited.revision+1);
  assert.deepEqual((await data('get_session',{session_id:sid,include_adjustments:true})).adjustments,before.adjustments);
  await data('restore_version',{session_id:sid,version_id:version.version_id,expected_revision:edited.revision},true);
  await verified('named_reference_survives_history_truncation_and_revision_conflict',['tool:save_version','tool:list_versions','tool:restore_version','tool:history'],{history_limit:32,restored_revision:restored.revision});
  await data('get_job',{job_id:'11111111-1111-4111-8111-111111111111'},true);
  // Use the larger image to guarantee enough work to exercise cancellation and interruption.
  const cancelling=await data('start_denoise',{session_id:large.session_id,method:'bm3d',intensity:50});
  await data('start_denoise',{session_id:sid,method:'bm3d'},true);
  await data('set_adjustments',{session_id:sid,patch:{temperature:4}});
  await call('render',{session_id:sid,long_edge:128});
  await data('cancel_job',{job_id:cancelling.job_id});
  await waitJob(cancelling.job_id,'cancelled');
  await verified('bm3d_cancellation_keeps_parent_editing_and_rendering_available',['tool:start_denoise','tool:cancel_job','tool:get_job'],{cancelled_job:cancelling.job_id});
  await data('set_adjustments',{session_id:sid,patch:{temperature:7}});
  const captured=await data('get_session',{session_id:sid,include_adjustments:true});
  const success=await data('start_denoise',{session_id:sid,method:'bm3d',intensity:35});
  await data('set_adjustments',{session_id:sid,patch:{temperature:19}});
  const done=await waitJob(success.job_id);
  const derived=await data('get_session',{session_id:done.result_session_id,include_adjustments:true});
  assert.deepEqual(derived.adjustments,captured.adjustments,'Job must inherit captured edits, not later parent changes');
  assert.equal(derived.is_raw,captured.is_raw);
  assert.equal(derived.metadata.derivedFrom.revision,captured.revision);
  await verified('completed_job_inherits_captured_state_and_raw_domain',['tool:start_denoise','tool:get_job'],{source_revision:captured.revision,result_session_id:derived.session_id,is_raw:derived.is_raw});
  await call('render',{session_id:derived.session_id,long_edge:512});
  await data('close_session',{session_id:derived.session_id});
  await data('get_session',{session_id:derived.session_id},true);
  assert.ok(!(await data('list_sessions')).sessions.some((s)=>s.session_id===derived.session_id),'Job polling must not reopen explicitly closed sessions');
  const interrupted=await data('start_denoise',{session_id:large.session_id,method:'bm3d',intensity:50});
  await reconnect();
  assert.equal((await data('get_job',{job_id:interrupted.job_id})).status,'interrupted');
  assert.equal((await data('get_job',{job_id:success.job_id})).result_session_id,derived.session_id);
  assert.deepEqual((await data('get_session',{session_id:derived.session_id,include_adjustments:true})).adjustments,captured.adjustments);
  assert.ok((await data('list_versions',{session_id:sid})).versions.some((v)=>v.version_id===version.version_id));
  const resumed=await data('resume_job',{job_id:interrupted.job_id});
  assert.equal(resumed.attempt,2); assert.equal(resumed.job_id,interrupted.job_id);
  await data('cancel_job',{job_id:resumed.job_id}); await waitJob(resumed.job_id,'cancelled');
  await verified('restart_recovery_preserves_completed_results_and_explicit_resume_identity',['tool:resume_job','tool:get_job','tool:list_versions','tool:close_session'],{resumed_job:resumed.job_id,attempt:resumed.attempt,completed_result:derived.session_id});
  if (process.env.RAPIDRAW_TEST_AI === '1') {
    await data('export',{session_id:sid,path:'ai-small.png',format:'png',bit_depth:16,long_edge:64});
    const tiny=await data('open_photo',{path:join(workspace,'exports','ai-small.png'),inherit_sidecar:false});
    const models=await data('models');
    assert.ok(models.groups.denoise.assets.every((a)=>a.verified || a.installed_app_copy_available),'AI test requires already installed assets; it never downloads');
    const ai=await data('start_denoise',{session_id:tiny.session_id,method:'ai',intensity:25});
    const aiResult=await waitJob(ai.job_id);
    await call('render',{session_id:aiResult.result_session_id,long_edge:64});
    const stopping=await data('start_denoise',{session_id:tiny.session_id,method:'ai',intensity:25});
    const deadline=Date.now()+30000;
    let observed;
    do {
      observed=await data('get_job',{job_id:stopping.job_id});
      if (observed.stage==='AI tiles' || observed.status!=='running') break;
      await new Promise((r)=>setTimeout(r,50));
    } while(Date.now()<deadline);
    assert.equal(observed.stage,'AI tiles','Exercise cancellation during actual AI inference');
    await data('cancel_job',{job_id:stopping.job_id});
    await call('render',{session_id:sid,long_edge:128});
    await waitJob(stopping.job_id,'cancelled');
    await verified('ai_background_completion_and_inference_cancellation',['tool:start_denoise','tool:cancel_job','parameter:start_denoise.method="ai"'],{completed_job:ai.job_id,cancelled_job:stopping.job_id});
  } else if(coverage) await coverage.skip('ai_background_completion_and_inference_cancellation',['parameter:start_denoise.method="ai"'],'Set RAPIDRAW_TEST_AI=1 with installed local denoise assets.');
  // A result must be discoverable after restart even if no client ever polled it.
  const unpolled=await data('start_denoise',{session_id:sid,method:'bm3d',intensity:0});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) {
    const manifest=JSON.parse(await readFile(join(workspace,'jobs',`${unpolled.job_id}.json`),'utf8'));
    if(manifest.status==='succeeded') break;
    await new Promise((r)=>setTimeout(r,100));
  }
  await reconnect();
  assert.equal((await data('get_job',{job_id:unpolled.job_id})).status,'succeeded');
  await verified('completed_job_is_discovered_after_restart_without_prior_polling',['tool:start_denoise','tool:get_job'],{job_id:unpolled.job_id});
  assert.equal(await hash(source),sourceHash);
  await writeFile(join(workspace,coverageEnabled?'review-jobs-summary.json':'summary.json'),JSON.stringify({ok:true,workspace,source_sha256:sourceHash,tools:caps.methods.length,checks:['temporary native comparisons','combined exposure and actual differences','named references survive history truncation and restart','asymmetric smooth gradient rendering','editing and rendering during denoise','cooperative cancellation without engine restart','captured edits inherited by derived result','durable completed result','interruption detection and explicit resume','completion without polling','source hash unchanged'],ai_tested:process.env.RAPIDRAW_TEST_AI === '1'},null,2));
  console.log(`PASS: ${workspace}`);
} catch(error){failure=error;throw error;}
finally {
  let closingError;
  try{if(coverage)await coverage.close(failure);else await client?.close();}catch(error){closingError=error;failure ??= error;}
  assert.equal(await hash(source),sourceHash,'Original photo changed');
  const after=await readFile(`${source}.rrdata`).catch((error)=>{if(error.code==='ENOENT')return null;throw error;});
  assert.deepEqual(after,sourceSidecar,'Original sidecar changed');
  if(closingError)throw closingError;
}
