"""Offline pointwise reranking of frozen pools. All inputs/outputs must stay private.

No gold labels enter the model. Scores, input visibility and execution provenance
are saved separately from grading. This script never queries a live index.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import random
import shutil
import sys
import time


def sha(file):
    h = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def serialize(row):
    return f"file: {row['file']}\nsymbol: {row.get('symbol') or ''}\n{row['text']}"


def canonical(rows, scores=None):
    values = {r["key"]: r["score"] for r in rows} if scores is None else scores
    if any(not math.isfinite(values[r["key"]]) for r in rows):
        raise ValueError("Non-finite ranking score")
    return sorted(rows, key=lambda r: (-values[r["key"]], r["key"]))


def validate_pack(pack):
    if pack["schemaVersion"] != 1:
        raise ValueError("Unknown pool schema")
    if len({q["id"] for q in pack["cases"]}) != len(pack["cases"]):
        raise ValueError("Duplicate query ID")
    for q in pack["cases"]:
        for pool in ("C", "U"):
            rows = q.get(pool) or []
            if len({r["key"] for r in rows}) != len(rows):
                raise ValueError("Duplicate candidate ID")
            for row in rows:
                if not isinstance(row["text"], str) or not isinstance(row["file"], str):
                    raise ValueError("Missing candidate text/metadata")
                if not math.isfinite(row["score"]):
                    raise ValueError("Invalid baseline score")
        if q.get("U"):
            by_key = {row["key"]: row for row in q["U"]}
            for row in q["C"]:
                if row["key"] not in by_key or serialize(by_key[row["key"]]) != serialize(row):
                    raise ValueError("C must be a text-identical subset of U")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ids", type=Path, help="Frozen JSON array of case IDs, for pilot only")
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--precision", choices=("fp16", "fp32"), default="fp16")
    parser.add_argument("--union", action="store_true", help="Development-only U1; reuse pointwise C scores and score extra U rows")
    args = parser.parse_args()
    if args.rounds < 1 or args.batch_size < 1 or args.max_length < 8:
        raise ValueError("Invalid run parameters")
    if args.device == "cpu" and args.precision != "fp32":
        raise ValueError("CPU requires explicit fp32")
    if args.output.exists():
        raise ValueError("Use a fresh output directory; never overwrite an evaluation")
    pack = read(args.pack)
    validate_pack(pack)
    cases = pack["cases"]
    if args.ids:
        ids = read(args.ids)
        if len(ids) != len(set(ids)) or not set(ids).issubset({q["id"] for q in cases}):
            raise ValueError("Unknown or duplicate pilot IDs")
        lookup = {q["id"]: q for q in cases}
        cases = [lookup[x] for x in ids]
    model_manifest = read(args.model / "snapshot-manifest.json")
    for name, entry in model_manifest["files"].items():
        if sha(args.model / name) != entry["sha256"]:
            raise ValueError("Model file changed: " + name)

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    random.seed(130914)
    torch.manual_seed(130914)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; do not silently switch devices")
    args.output.mkdir(parents=True)
    shutil.copyfile(__file__, args.output / "scorer-snapshot.py")
    sync = torch.cuda.synchronize if args.device == "cuda" else lambda: None
    dtype = torch.float16 if args.precision == "fp16" else torch.float32
    started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True, use_fast=True, trust_remote_code=False)
    tokenizer.truncation_side = "right"
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model, local_files_only=True, trust_remote_code=False, use_safetensors=True,
        torch_dtype=dtype, attn_implementation="eager",
    ).to(args.device).eval()
    sync()
    load_ms = (time.perf_counter() - started) * 1000
    environment = {
        "schemaVersion": 1, "packSha256": sha(args.pack), "scorerSha256": sha(__file__),
        "model": model_manifest, "python": sys.version, "platform": platform.platform(),
        "packages": {m: importlib.metadata.version(m) for m in ("torch", "transformers", "tokenizers", "safetensors")},
        "device": args.device, "gpu": torch.cuda.get_device_name() if args.device == "cuda" else None,
        "precision": args.precision, "batchSize": args.batch_size, "maxLength": args.max_length,
        "padding": "max_length", "truncation": "only_second:right", "attention": "eager",
        "seed": 130914, "deterministicAlgorithms": True, "tf32": False,
        "serialization": "file: {file}\\nsymbol: {symbol}\\n{text}",
        "queryIds": [q["id"] for q in cases], "rounds": args.rounds, "unionDiagnostic": args.union,
        "modelLoadMs": load_ms, "qualityLabelsUsedForScoring": False, "warmupPairs": 1,
    }
    (args.output / "environment.local.json").write_text(json.dumps(environment, indent=2) + "\n", encoding="utf-8")
    # Kernel warmup uses synthetic input, never a hidden test example.
    warmup = tokenizer("warmup", "synthetic warmup text", max_length=args.max_length,
                       padding="max_length", truncation="only_second", return_tensors="pt").to(args.device)
    with torch.inference_mode():
        model(**warmup)
    sync()

    def score_rows(query, rows, cost):
        result, visibility = {}, {}
        cost.update(pairs=0, scoredPairs=0, inputTokens=0, truncatedPairs=0, tokenizeMs=0.0, inferenceMs=0.0)
        # Canonical batches give the same numerical input under candidate enumeration permutations.
        rows = sorted(rows, key=lambda row: row["key"])
        for offset in range(0, len(rows), args.batch_size):
            batch = rows[offset:offset + args.batch_size]
            texts = [serialize(row) for row in batch]
            t0 = time.perf_counter()
            encoded = tokenizer([query] * len(batch), texts, max_length=args.max_length,
                                truncation="only_second", padding="max_length",
                                return_offsets_mapping=True, return_tensors="pt")
            for i, (row, text) in enumerate(zip(batch, texts)):
                full_tokens = len(tokenizer.encode(text, add_special_tokens=False))
                positions = [j for j, sequence in enumerate(encoded.sequence_ids(i)) if sequence == 1]
                ends = [int(encoded["offset_mapping"][i][j][1]) for j in positions]
                visible_end = max(ends, default=0)
                used = int(encoded["attention_mask"][i].sum())
                cost["inputTokens"] += used
                is_truncated = len(positions) < full_tokens
                cost["truncatedPairs"] += int(is_truncated)
                visibility[row["key"]] = {"documentTokens": full_tokens, "inputTokens": used,
                                          "visibleDocumentEnd": visible_end, "truncated": is_truncated}
            del encoded["offset_mapping"]
            encoded = encoded.to(args.device)
            cost["tokenizeMs"] += (time.perf_counter() - t0) * 1000
            sync()
            t0 = time.perf_counter()
            cost["pairs"] += len(batch)
            try:
                with torch.inference_mode():
                    values = model(**encoded).logits.flatten().float().cpu().tolist()
                sync()
            finally:
                cost["inferenceMs"] += (time.perf_counter() - t0) * 1000
            if len(values) != len(batch) or not all(math.isfinite(x) for x in values):
                raise ValueError("Non-finite or wrong-size model output")
            for row, value in zip(batch, values):
                result[row["key"]] = value
            cost["scoredPairs"] += len(batch)
        return result, visibility

    with (args.output / "scores.local.jsonl").open("w", encoding="utf-8") as output:
        for round_index in range(1, args.rounds + 1):
            for q in cases:
                t0 = time.perf_counter()
                row = {"id": q["id"], "round": round_index, "bypassExact": q["bypassExact"],
                       "B0": [r["key"] for r in q["C"]], "BC": [r["key"] for r in canonical(q["C"])],
                       "error": None, "scores": {}, "visibility": {}, "cost": {"pairs": 0}}
                if q["bypassExact"]:
                    row["BC"] = row["B0"]
                    row["R1"] = row["B0"]
                else:
                    try:
                        row["scores"], row["visibility"] = score_rows(q["query"], q["C"], row["cost"])
                        row["R1"] = [r["key"] for r in canonical(q["C"], row["scores"])]
                    except Exception as exc:
                        # Preserve the failed case in the denominator; this is a recorded fallback.
                        row["error"] = type(exc).__name__ + ": " + str(exc)
                        row["R1"] = row["B0"]
                        if args.device == "cuda":
                            torch.cuda.empty_cache()
                row["primaryElapsedMs"] = (time.perf_counter() - t0) * 1000
                if args.union and q.get("U") and not q["bypassExact"] and row["error"] is None:
                    # An optional U diagnostic failure must not overwrite a successful R1 result.
                    row["U0"] = [r["key"] for r in q["U"]]
                    row["unionExtraCost"] = {}
                    try:
                        extras = [r for r in q["U"] if r["key"] not in row["scores"]]
                        scores, visibility = score_rows(q["query"], extras, row["unionExtraCost"])
                        row["unionScores"] = {**row["scores"], **scores}
                        row["unionVisibility"] = {**row["visibility"], **visibility}
                        row["U1"] = [r["key"] for r in canonical(q["U"], row["unionScores"])]
                    except Exception as exc:
                        row["unionError"] = type(exc).__name__ + ": " + str(exc)
                        if args.device == "cuda":
                            torch.cuda.empty_cache()
                row["elapsedMs"] = (time.perf_counter() - t0) * 1000
                row["peakAllocatedBytes"] = torch.cuda.max_memory_allocated() if args.device == "cuda" else None
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(json.dumps({"id": q["id"], "round": round_index, "candidates": len(q["C"]),
                                  "pairs": row["cost"]["pairs"], "elapsedMs": round(row["elapsedMs"], 1),
                                  "failed": row["error"] is not None}), flush=True)
    (args.output / "complete.local.json").write_text(json.dumps({
        "questions": len(cases), "rounds": args.rounds, "scoreRows": len(cases) * args.rounds,
        "scoresSha256": sha(args.output / "scores.local.jsonl"),
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
