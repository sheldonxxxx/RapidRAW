"""Download a curated manifest, checking published checksums and disk reserve."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import time
import urllib.request


def download_manifest(manifest_path, destination):
    manifest=json.loads(Path(manifest_path).read_text())
    destination=Path(destination)
    destination.mkdir(parents=True,exist_ok=True)
    required=sum(f["bytes"] for f in manifest["files"])
    if shutil.disk_usage(destination).free < required + 20*1024**3:
        raise RuntimeError("Dataset exceeds disk reserve")
    def one(entry):
        name=entry["filename"]
        if Path(name).name != name:
            raise ValueError("Dataset filenames must be basenames")
        target=destination/name
        checksum=entry["checksum"]
        algorithm=checksum["type"].lower().replace("-","")
        def valid(path):
            if not path.exists() or path.stat().st_size!=entry["bytes"]:
                return False
            d=hashlib.new(algorithm)
            with path.open("rb") as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b""):d.update(chunk)
            return d.hexdigest().lower()==checksum["value"].lower()
        if not valid(target):
            temp=target.with_suffix(target.suffix+".part")
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(entry["url"],timeout=90) as source,temp.open("wb") as output:
                        shutil.copyfileobj(source,output)
                    if not valid(temp):raise RuntimeError("Dataset checksum mismatch")
                    temp.replace(target)
                    break
                except Exception:
                    if attempt==2:raise
                    time.sleep(2)
        print(json.dumps({"downloaded":name,"verified":True}),flush=True)
        return str(target)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(one,manifest["files"]))


if __name__=="__main__":
    import argparse
    p=argparse.ArgumentParser();p.add_argument("manifest");p.add_argument("destination")
    a=p.parse_args();download_manifest(a.manifest,a.destination)
