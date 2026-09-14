/** Native enhancement acceptance using caller-supplied photographs and model assets.
 * The report records runtime/contract evidence; photographic quality needs review.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NativeBridge } from '../dist/bridge.js';
import { OperationJobs } from '../dist/operation-jobs.js';

assert.ok(process.env.RAPIDRAW_ENHANCEMENT_MANIFEST, 'Set RAPIDRAW_ENHANCEMENT_MANIFEST to a private fixture/model manifest');
assert.ok(process.env.RAPIDRAW_BINARY, 'Set RAPIDRAW_BINARY to a feature-enabled native build');
const manifest=JSON.parse(await readFile(resolve(process.env.RAPIDRAW_ENHANCEMENT_MANIFEST),'utf8'));
const workspace=resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/enhancement-${Date.now()}`);
await mkdir(workspace,{recursive:true});
const hash=async(path)=>createHash('sha256').update(await readFile(path)).digest('hex');
const options={binary:resolve(process.env.RAPIDRAW_BINARY),workspace,timeoutMs:1_800_000};
let bridge=new NativeBridge(options);
let jobs=new OperationJobs(bridge,options);
const report={cases:[],checks:[],quality:'Requires rendered review',started:new Date().toISOString()};
const call=(method,args={})=>bridge.request(method,args);
const render=async(session_id,path,mask_id)=>{
  const response=await call('render',{session_id,format:'png',long_edge:1600,...(mask_id?{mask_id,mask_mode:'grayscale'}:{})});
  await writeFile(path,Buffer.from(response.image.data,'base64'));
  return response.image.data;
};
try {
  const capabilities=await call('capabilities');assert.ok(capabilities.methods.includes('enhance'));
  for(const item of manifest.models){await call('install_enhancement_model',{model_id:item.id,path:resolve(item.path),sha256:item.sha256??await hash(resolve(item.path))});}
  for(const fixture of manifest.cases){
    assert.match(fixture.id,/^[a-zA-Z0-9_-]+$/);
    const directory=join(workspace,fixture.id);await mkdir(directory);
    const source=resolve(fixture.path),sourceHash=await hash(source);
    let opened=await call('open_photo',{path:source,inherit_sidecar:false});
    let parent=await call('get_session',{session_id:opened.session_id,include_adjustments:true});
    const baseline=await render(parent.session_id,join(directory,'baseline.png'));
    let mask_id;
    if(fixture.mask_path){
      const bitmap=await readFile(resolve(fixture.mask_path));
      const created=await call('set_adjustments',{session_id:parent.session_id,expected_revision:parent.revision,mode:'merge',patch:{masks:[{id:randomUUID(),name:'Source selection',visible:true,invert:false,opacity:100,adjustments:{exposure:0.5},subMasks:[{id:randomUUID(),type:'ai-subject',visible:true,invert:false,opacity:100,mode:'additive',parameters:{startX:0,startY:0,endX:parent.dimensions.width,endY:parent.dimensions.height,maskDataBase64:`data:image/png;base64,${bitmap.toString('base64')}`,rotation:0,orientationSteps:0,flipHorizontal:false,flipVertical:false,grow:0,feather:0}}]}]}});
      parent=await call('get_session',{session_id:created.session_id,include_adjustments:true});mask_id=parent.adjustments.masks.at(-1).id;
      await render(parent.session_id,join(directory,'mask-before.png'),mask_id);
    }
    const args={session_id:parent.session_id,expected_revision:parent.revision,request:{...fixture.request,provider:process.env.RAPIDRAW_ENHANCEMENT_PROVIDER??fixture.request.provider??'auto'},...(mask_id?{mask_id}:{})};
    await assert.rejects(call('enhance',{...args,expected_revision:parent.revision+1}),error=>error.code==='REVISION_CONFLICT');
    if(fixture.expected_error){
      await assert.rejects(call('enhance',args),error=>error.code===fixture.expected_error||String(error).includes(fixture.expected_error));
      assert.deepEqual(await call('get_session',{session_id:parent.session_id,include_adjustments:true}),parent);
      assert.equal(await hash(source),sourceHash);
      report.cases.push({id:fixture.id,request:args.request,expected_error:fixture.expected_error,verified:true});
      process.stdout.write(`${fixture.id}: rejected as expected, parent unchanged\n`);
      continue;
    }
    const started=performance.now();const result=await call('enhance',args);const elapsed=performance.now()-started;
    const enhanced=await call('get_session',{session_id:result.session_id,include_adjustments:true});
    const photo=await render(result.session_id,join(directory,'result.png'));
    if(result.mask_id) await render(result.session_id,join(directory,'mask-after.png'),result.mask_id);
    assert.equal(await hash(source),sourceHash,'Original photo changed');
    if(fixture.request.operation==='deblur'||fixture.request.operation==='upscale'){
      assert.notEqual(result.session_id,parent.session_id);assert.equal(result.edits_baked,true);assert.equal(enhanced.is_raw,false);
      const current=await call('get_session',{session_id:parent.session_id,include_adjustments:true});assert.deepEqual(current.adjustments,parent.adjustments);assert.equal(current.revision,parent.revision);
      const scale=fixture.request.operation==='upscale'?2:1;
      const [w,h]=fixture.request.region?.slice(2)??[parent.dimensions.width,parent.dimensions.height];assert.deepEqual(enhanced.dimensions,{width:w*scale,height:h*scale});
    }else{
      assert.equal(result.session_id,parent.session_id);
      if(mask_id){assert.equal(result.mask_id,mask_id);assert.deepEqual(enhanced.adjustments.masks[0].adjustments,parent.adjustments.masks[0].adjustments);}
      await call('undo',{session_id:result.session_id});
      assert.deepEqual((await call('get_session',{session_id:result.session_id,include_adjustments:true})).adjustments,parent.adjustments);
      await call('redo',{session_id:result.session_id});
      assert.equal(await render(result.session_id,join(directory,'redo.png')),photo);
    }
    if(fixture.background_check){
      const current=await call('get_session',{session_id:enhanced.session_id,include_adjustments:true});
      const backgroundArgs={...args,session_id:current.session_id,expected_revision:current.revision};
      const job=await jobs.dispatch('start_operation',{operation:'enhance',arguments:backgroundArgs});
      const cancelled=await jobs.dispatch('cancel_operation_job',{job_id:job.job_id});assert.equal(cancelled.status,'cancelled');
      await jobs.dispatch('resume_operation_job',{job_id:job.job_id});
      const deadline=Date.now()+600_000;let finished;
      do {await new Promise(resolve=>setTimeout(resolve,250));finished=await jobs.dispatch('get_operation_job',{job_id:job.job_id});}while(finished.status==='running'&&Date.now()<deadline);
      assert.equal(finished.status,'succeeded',finished.error??'Background enhancement timed out');
      assert.equal(finished.attempt,2);assert.notEqual(finished.result.session_id,enhanced.session_id);
      report.checks.push(`${fixture.id}: native worker cancellation, explicit resume and separate result`);
    }
    const saved=await call('save_session',{session_id:result.session_id});assert.ok(saved.path);
    const exported=await call('export',{session_id:result.session_id,path:`${fixture.id}.tiff`,format:'tiff',bit_depth:16,color_profile:'srgb'});assert.ok(exported.path);
    await jobs.close();await bridge.close();bridge=new NativeBridge(options);jobs=new OperationJobs(bridge,options);
    assert.equal(await render(result.session_id,join(directory,'restart.png')),photo,'Rendered result changed after restart');
    const entry={id:fixture.id,source_sha256:sourceHash,request:args.request,elapsed_ms:elapsed,result,export:exported,baseline:join(directory,'baseline.png'),preview:join(directory,'result.png'),quality:'not_reviewed'};
    await writeFile(join(directory,'result.json'),JSON.stringify(entry,null,2));report.cases.push(entry);
    process.stdout.write(`${fixture.id}: ${Math.round(elapsed)}ms, persisted and exported\n`);
  }
  report.checks.push('source preservation','revision rejection','mask history or independent restoration session','restart pixel equality','16-bit sRGB export');
}catch(error){report.error=String(error);process.stderr.write(`${error.stack??error}\n`);process.exitCode=1;}
finally {await jobs.close();await bridge.close();await writeFile(join(workspace,'enhancement-report.json'),JSON.stringify(report,null,2));}
