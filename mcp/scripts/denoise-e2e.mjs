/** Real-MCP regression for a persistent linear RAW-domain denoise session.
 * The fixture is RGB32F TIFF. Only its isolated session manifest is marked as
 * linear RAW after initialization, to exercise the same state as decoded RAW
 * without requiring full-resolution inference on a camera file.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const binary = process.env.RAPIDRAW_BINARY;
assert.ok(binary, 'Set RAPIDRAW_BINARY');
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? 'test-output/denoise-domain');
await mkdir(workspace, {recursive:true});
const fixture = join(workspace,'linear-fixture.tiff');
const started=performance.now();
function writeFloatTiff() {
  const width=96,height=64,count=11,ifdSize=2+count*12+4,bits=8+ifdSize,formats=bits+6,pixels=formats+6;
  const buffer=Buffer.alloc(pixels+width*height*12);
  buffer.write('II');buffer.writeUInt16LE(42,2);buffer.writeUInt32LE(8,4);buffer.writeUInt16LE(count,8);
  const tags=[[256,4,1,width],[257,4,1,height],[258,3,3,bits],[259,3,1,1],[262,3,1,2],[273,4,1,pixels],[277,3,1,3],[278,4,1,height],[279,4,1,width*height*12],[284,3,1,1],[339,3,3,formats]];
  tags.forEach(([tag,type,n,value],index)=>{const at=10+index*12;buffer.writeUInt16LE(tag,at);buffer.writeUInt16LE(type,at+2);buffer.writeUInt32LE(n,at+4);buffer.writeUInt32LE(value,at+8);});
  for(let c=0;c<3;c++){buffer.writeUInt16LE(32,bits+c*2);buffer.writeUInt16LE(3,formats+c*2);}
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++){
    const base=[0.18,0.5,1.4][Math.floor(x/32)];
    buffer.writeFloatLE(base+(((x+y+c)%2)*2-1)*0.001,pixels+((y*width+x)*3+c)*4);
  }
  return buffer;
}
function readFloatTiff(buffer) {
  assert.equal(buffer.toString('ascii',0,2),'II');
  const ifd=buffer.readUInt32LE(4),tags=new Map();
  for(let i=0;i<buffer.readUInt16LE(ifd);i++){
    const at=ifd+2+i*12,tag=buffer.readUInt16LE(at),type=buffer.readUInt16LE(at+2),n=buffer.readUInt32LE(at+4),size=type===3?2:4;
    const offset=n*size<=4?at+8:buffer.readUInt32LE(at+8);
    tags.set(tag,Array.from({length:n},(_,j)=>size===2?buffer.readUInt16LE(offset+j*size):buffer.readUInt32LE(offset+j*size)));
  }
  assert.equal(tags.get(259)[0],1,'Fixture comparison expects uncompressed TIFF');
  assert.equal(tags.get(258)[0],32);assert.equal(tags.get(339)[0],3);
  const bytes=Buffer.concat(tags.get(273).map((offset,i)=>buffer.subarray(offset,offset+tags.get(279)[i])));
  return {width:tags.get(256)[0],height:tags.get(257)[0],values:Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4))};
}
await writeFile(fixture,writeFloatTiff());
let client;
const records=[];
async function connect(){
  client=new Client({name:'denoise-domain-e2e',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--binary',binary,'--workspace',workspace],stderr:'inherit'}));
}
async function call(method,args){
  console.log(method,args.method??'');
  const started=performance.now();
  const result=await client.callTool({name:`rapidraw_${method}`,arguments:args},{timeout:600000});
  assert.ok(!result.isError,JSON.stringify(result));
  records.push({method,args,elapsed_ms:Math.round(performance.now()-started),data:result.structuredContent});
  return result;
}
async function render(id){return (await call('render',{session_id:id,format:'png'})).content.find(c=>c.type==='image').data;}
try {
  await connect();
  const opened=(await call('open_photo',{path:fixture,inherit_sidecar:false})).structuredContent;
  await client.close();
  const manifest=join(workspace,'sessions',opened.session_id,'session.json');
  const session=JSON.parse(await readFile(manifest,'utf8'));
  session.is_raw=true;session.history[0].metadata.mcpSourceDomain='linear-raw';
  await writeFile(manifest,JSON.stringify(session));
  await connect();
  const patch={toneMapper:'agx',exposure:0.4,temperature:8,highlights:-15};
  await call('set_adjustments',{session_id:session.id,patch});
  const before=(await call('get_session',{session_id:session.id,include_adjustments:true})).structuredContent;
  const baseline=await render(session.id);
  const zero=(await call('denoise',{session_id:session.id,method:'ai',intensity:0,expected_revision:before.revision})).structuredContent;
  assert.equal(zero.session_id,session.id);assert.equal(zero.revision,before.revision);assert.equal(zero.changed,false);
  assert.deepEqual(zero.adjustments,before.adjustments);assert.equal(await render(session.id),baseline);
  const original=readFloatTiff(await readFile(fixture));
  const results=[];
  for(const method of ['bm3d','ai']){
    const denoised=(await call('denoise',{session_id:session.id,method,intensity:25,expected_revision:before.revision})).structuredContent;
    assert.equal(denoised.is_raw,true);assert.equal(denoised.source_domain_preserved,true);
    assert.deepEqual(denoised.adjustments,before.adjustments);
    assert.equal(denoised.metadata.mcpSourceDomain,'linear-raw');
    assert.match(denoised.warnings.join(' '),/saved MCP session/);
    const image=readFloatTiff(await readFile(denoised.working_path));
    assert.deepEqual([image.width,image.height],[original.width,original.height]);
    const max=Math.max(...image.values);assert.ok(max>1.3,'Linear highlight headroom was lost');
    // Compare interior flat regions so edge smoothing is not mistaken for a
    // tonal shift. The old display bake fails the midtone check by >0.2.
    const means=[],noise=[];
    for(let band=0;band<3;band++){
      let delta=0,n=0,sum=0,square=0,originalSum=0,originalSquare=0;
      for(let y=16;y<48;y++)for(let x=band*32+10;x<band*32+22;x++)for(let c=0;c<3;c++){
        const i=(y*image.width+x)*3+c;delta+=image.values[i]-original.values[i];n++;
        sum+=image.values[i];square+=image.values[i]**2;originalSum+=original.values[i];originalSquare+=original.values[i]**2;
      }
      means.push(delta/n);
      noise.push({before:Math.sqrt(Math.max(0,originalSquare/n-(originalSum/n)**2)),after:Math.sqrt(Math.max(0,square/n-(sum/n)**2))});
    }
    assert.ok(means.every(d=>Math.abs(d)<0.025),`${method} gratuitous tone drift ${means}`);
    if(method==='bm3d')assert.ok(noise.every(n=>n.after<n.before*0.95),'BM3D did not reduce the flat-field fixture noise');
    const preview=await render(denoised.session_id);
    await call('save_session',{session_id:denoised.session_id});
    await client.close();await connect();
    const restored=(await call('get_session',{session_id:denoised.session_id,include_adjustments:true})).structuredContent;
    assert.equal(restored.is_raw,true);assert.deepEqual(restored.adjustments,before.adjustments);
    assert.equal(await render(denoised.session_id),preview,'Rendering changed after reconnect');
    results.push({method,session_id:denoised.session_id,max_linear_value:max,mean_source_deltas:means,flat_field_noise:noise});
  }
  assert.equal((await call('get_session',{session_id:session.id})).structuredContent.revision,before.revision);
  assert.deepEqual(await readFile(fixture),writeFloatTiff(),'Fixture source changed');
  if(process.env.RAPIDRAW_MASK_TEST_IMAGE){
    const photo=(await call('open_photo',{path:process.env.RAPIDRAW_MASK_TEST_IMAGE,inherit_sidecar:false})).structuredContent;
    const generated=(await call('mask_generate',{session_id:photo.session_id,kind:'foreground',adjustments:{curveMode:'parametric',parametricCurve:{luma:{shadows:50}}}})).structuredContent;
    const state=(await call('get_session',{session_id:photo.session_id,include_adjustments:true})).structuredContent;
    const local=state.adjustments.masks.find(mask=>mask.id===generated.mask_id).adjustments;
    assert.ok(local.curves.luma.some(point=>Math.abs(point.x-point.y)>0.01),'AI local parametric curve was not compiled');
    await render(photo.session_id);
  }
  const elapsed_ms=Math.round(performance.now()-started);
  await writeFile(join(workspace,'denoise-domain-evidence.json'),JSON.stringify({status:'passed',elapsed_ms,results,records},null,2));
  console.log(JSON.stringify({status:'passed',workspace,elapsed_ms,calls:records.length,results},null,2));
} finally {await client?.close();}
