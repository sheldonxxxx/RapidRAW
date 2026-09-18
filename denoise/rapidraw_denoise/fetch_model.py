"""Fetch the pinned authors' release and convert it to a tensor-only checkpoint."""
import argparse
import importlib
from pathlib import Path
import urllib.request
import torch
from .raw import sha256

URL="https://github.com/MIA-UIB/nonlocal-matchfilter/releases/download/v1.0.0/rawnoise_25_15_9nbr.ckpt"
SHA256="b31bc8e21022389b0b209a9d1e6649485ed4dacc552b7ea04612df5f7515fcf2"
ALLOWED={"omegaconf.listconfig.ListConfig","omegaconf.nodes.AnyNode","omegaconf.base.ContainerMetadata",
         "omegaconf.base.Metadata","builtins.list","builtins.dict","builtins.int","collections.defaultdict","typing.Any"}


def main():
    p=argparse.ArgumentParser();p.add_argument("directory",type=Path);a=p.parse_args()
    a.directory.mkdir(parents=True,exist_ok=True)
    source=a.directory/"nonlocal-raw.ckpt";target=a.directory/"nonlocal-raw-weights.pt"
    if target.exists():raise FileExistsError(target)
    if not source.exists():
        temp=source.with_suffix(".part")
        urllib.request.urlretrieve(URL,temp)
        if sha256(temp)!=SHA256:raise RuntimeError("Release checksum mismatch")
        temp.replace(source)
    if sha256(source)!=SHA256:raise RuntimeError("Release checksum mismatch")
    names=set(torch.serialization.get_unsafe_globals_in_checkpoint(source))
    if not names<=ALLOWED:raise RuntimeError(f"Unexpected serialization globals: {names-ALLOWED}")
    objects=[getattr(importlib.import_module(n.rsplit(".",1)[0]),n.rsplit(".",1)[1]) for n in names]
    with torch.serialization.safe_globals(objects):
        data=torch.load(source,map_location="cpu",weights_only=True)
    state=data["state_dict"]
    if not all(isinstance(v,torch.Tensor) for v in state.values()):raise RuntimeError("Expected only tensors")
    torch.save(state,target)
    print(f"{sha256(target)}  {target}")


if __name__=="__main__":main()
