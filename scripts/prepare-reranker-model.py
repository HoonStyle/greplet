"""Download an immutable, public reranker snapshot; never send evaluation inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

FILES = (
    "config.json", "model.safetensors", "sentencepiece.bpe.model",
    "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "README.md",
)


def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if len(args.revision) != 40 or any(c not in "0123456789abcdef" for c in args.revision):
        raise ValueError("An immutable 40-character commit is required")
    repo = "BAAI/bge-reranker-v2-m3"
    base = "https://huggingface.co/" + repo
    with urllib.request.urlopen(
        "https://huggingface.co/api/models/" + repo + "/revision/" + args.revision + "?blobs=true", timeout=60
    ) as response:
        info = json.load(response)
    if info["sha"] != args.revision:
        raise ValueError("Model revision mismatch")
    siblings = {row["rfilename"]: row for row in info["siblings"]}
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"repo": repo, "revision": args.revision, "files": {}}
    for name in FILES:
        item = siblings[name]
        target = args.output / name
        expected_hash = item.get("lfs", {}).get("sha256")
        expected_size = item.get("size")
        if not target.exists():
            partial = target.with_suffix(target.suffix + ".part")
            # Publish complete files only. Retrying a partial download starts afresh.
            with urllib.request.urlopen(base + "/resolve/" + args.revision + "/" + name, timeout=120) as response:
                with partial.open("wb") as stream:
                    while block := response.read(8 * 1024 * 1024):
                        stream.write(block)
            if expected_size is not None and partial.stat().st_size != expected_size:
                raise ValueError("File size mismatch: " + name)
            if expected_hash and digest(partial) != expected_hash:
                raise ValueError("LFS checksum mismatch: " + name)
            partial.rename(target)
        actual_hash = digest(target)
        if expected_size is not None and target.stat().st_size != expected_size:
            raise ValueError("Existing file size mismatch: " + name)
        if expected_hash and actual_hash != expected_hash:
            raise ValueError("Existing LFS checksum mismatch: " + name)
        manifest["files"][name] = {"sha256": actual_hash, "bytes": target.stat().st_size}
        print(json.dumps({"file": name, **manifest["files"][name]}), flush=True)
    (args.output / "snapshot-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
