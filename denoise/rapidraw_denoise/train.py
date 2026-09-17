"""Small, reproducible domain-adaptation experiment with untouched scene splits.

Fine-tunes the released nonlocal model using sensor-noise synthesis. It does
not train a foundation denoiser from scratch or imply benchmark leadership.
"""
import argparse
import json
from pathlib import Path
import random
import shutil
import time
import numpy as np
import torch
from .raw import sha256
from .inference import load_model
from .benchmark import cases,metrics
from .noise import synthesize


def main():
    p=argparse.ArgumentParser();p.add_argument("--manifest",required=True);p.add_argument("--data",required=True)
    p.add_argument("--checkpoint",required=True);p.add_argument("--output",required=True,type=Path)
    p.add_argument("--steps",type=int,default=400);p.add_argument("--seed",type=int,default=917)
    p.add_argument("--structured",action="store_true");p.add_argument("--learning-rate",type=float,default=1e-5)
    a=p.parse_args()
    if a.steps<1:raise ValueError("Steps must be positive")
    if a.output.exists():raise FileExistsError(a.output)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    if shutil.disk_usage(a.output.parent).free < 21*1024**3:
        raise OSError("Training requires a 20 GiB reserve plus checkpoint allowance")
    a.output.mkdir(parents=True)
    torch.manual_seed(a.seed);np.random.seed(a.seed);random.seed(a.seed)
    torch.set_num_threads(4)
    model=load_model(a.checkpoint)
    training=list(cases(a.manifest,a.data,"train"))
    validation=list(cases(a.manifest,a.data,"validation",size=128))
    if not training or not validation:raise ValueError("Both train and validation scenes are required")
    if {c['scene'] for c,_ in training}&{c['scene'] for c,_ in validation}:raise ValueError("Scene leakage")
    optimizer=torch.optim.AdamW(model.parameters(),lr=a.learning_rate,weight_decay=0.)
    rng=np.random.default_rng(a.seed)
    val=[]
    for i,(case,clean) in enumerate(validation):
        for structured in (False,True):
            shot,read=(.008,8e-5) if structured else (.003,3e-5)
            noisy=synthesize(clean,[shot]*4,[read]*4,19000+i,row_sigma=.0015 if structured else 0,black_bias=.0005 if structured else 0)
            clipped=np.clip(noisy,0,1)
            x=np.concatenate([clipped,np.sqrt(np.maximum(shot*clipped+read,1e-12))])
            val.append((torch.from_numpy(x[None]).cuda(),clean))
    def evaluate():
        model.eval()
        with torch.inference_mode():
            return [metrics(clean,model(x)[0].cpu().numpy())["psnr"] for x,clean in val]
    start=time.monotonic();base=evaluate();best_mean=float(np.mean(base));best=0
    torch.save(model.state_dict(),a.output/"best.pt")
    history=[{"step":0,"validation_psnr":base,"mean":best_mean}]
    protocol={"initial_sha256":sha256(a.checkpoint),"manifest_sha256":sha256(a.manifest),"seed":a.seed,
              "steps":a.steps,"learning_rate":a.learning_rate,"structured":a.structured,
              "training_scenes":[c['scene'] for c,_ in training],"validation_scenes":[c['scene'] for c,_ in validation],
              "selection":"Highest mean validation PSNR with no crop regression exceeding 0.20 dB versus initialization",
              "limitations":"Small adaptation experiment; low-ISO targets contain residual noise; upstream pretraining overlap unknown"}
    (a.output/"protocol.json").write_text(json.dumps(protocol,indent=2)+"\n")
    torch.cuda.reset_peak_memory_stats()
    for step in range(1,a.steps+1):
        model.train()
        _,image=training[int(rng.integers(len(training)))];_,h,w=image.shape
        y=int(rng.integers(h-128+1));x=int(rng.integers(w-128+1))
        clean=image[:,y:y+128,x:x+128]
        clean=np.rot90(clean,int(rng.integers(4)),axes=(1,2)).copy()
        if rng.random()<.5:clean=clean[:,:,::-1].copy()
        # Exposure diversity and per-channel sensor gain variation.
        clean=np.clip(clean*float(np.exp(rng.uniform(np.log(.4),np.log(2.)))),0,1)
        shot=np.exp(rng.uniform(np.log(.0003),np.log(.012)))*np.exp(rng.normal(0,.1,4))
        read=np.exp(rng.uniform(np.log(1e-6),np.log(.00015)))*np.exp(rng.normal(0,.15,4))
        row=float(rng.uniform(0,.002)) if a.structured else 0.
        bias=float(rng.uniform(-.0008,.0008)) if a.structured else 0.
        noisy=synthesize(clean,shot,read,int(rng.integers(2**31)),row_sigma=row,black_bias=bias)
        clipped=np.clip(noisy,0,1)
        # Jitter conditions to train tolerance to estimated, rather than oracle, noise.
        jitter=np.exp(rng.normal(0,.10)) if a.structured else 1.
        sigma=np.sqrt(np.maximum(shot[:,None,None]*clipped+read[:,None,None],1e-12))*jitter
        input=torch.from_numpy(np.concatenate([clipped,sigma]).astype(np.float32)[None]).cuda()
        target=torch.from_numpy(clean[None]).cuda()
        optimizer.zero_grad(set_to_none=True)
        output=model(input)
        # RAW-domain fidelity plus a bounded shadow emphasis; no GAN/perceptual
        # term that could reward invented texture.
        weight=torch.rsqrt(target.detach().clamp_min(.03))
        loss=((output-target).abs()*weight).mean()
        loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.)
        optimizer.step()
        if step%50==0 or step==a.steps:
            score=evaluate();mean=float(np.mean(score));delta=np.array(score)-base
            if mean>best_mean and float(delta.min())>=-.20:
                best_mean=mean;best=step;torch.save(model.state_dict(),a.output/"best.pt")
            record={"step":step,"loss":float(loss.detach()),"mean":mean,"validation_psnr":score,
                    "worst_delta":float(delta.min()),"best_step":best,"elapsed_seconds":time.monotonic()-start,
                    "peak_tensor_vram_bytes":torch.cuda.max_memory_allocated()}
            history.append(record);print(json.dumps(record),flush=True)
            torch.save({"state_dict":model.state_dict(),"optimizer":optimizer.state_dict(),"step":step,
                        "numpy_rng":rng.bit_generator.state,"torch_rng":torch.get_rng_state()},a.output/"last.pt")
            (a.output/"history.json").write_text(json.dumps(history,indent=2)+"\n")
    print(json.dumps({"best_step":best,"initial_mean":float(np.mean(base)),"best_mean":best_mean}),flush=True)


if __name__=="__main__":main()
