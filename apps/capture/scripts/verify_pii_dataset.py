#!/usr/bin/env python3
"""Evaluate the production Rust detector on a pinned, entirely synthetic HF test split.
No production library or API inference is used. Downloads are explicit; cached
evaluations run offline. Requires pyarrow only for this verification script.
"""
import argparse
import ast
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import random
import re
import statistics
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATASET = "gretelai/gretel-pii-masking-en-v1"
REVISION = "e06eb1499ca8d54470f085021cd8e54f9efac7fd"
FILE = "data/test-00000-of-00001.parquet"
SHA256 = "c89a6bffa838edb0f2fc6686bf35da4930944519ac97308b0b6e32298594b5b1"
SUPPORTED_LABELS = {"email", "phone_number", "ssn", "credit_card_number", "iban", "secret"}

def occurrences(text, value):
    start = 0
    while value and (start := text.find(value, start)) >= 0:
        yield start, start + len(value)
        start += len(value)

def generated_controls():
    """Independent format variations plus negative controls; all values synthetic."""
    rng = random.Random(2048)
    positives = {
        "email": ["alice@example.com", "alice+refund@example.org", "o'connor@example.net", "élise@example.com"],
        "credit_card_number": ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"],
        "ssn": ["123-45-6789", "123 45 6789", "123.45.6789"],
        "phone_number": ["+1 555 0100", "(555) 010-0100", "+44 20 7946 0958", "+1-555-010-0100x2048", "1 (555) 010-0100"],
        "iban": ["GB82 WEST 1234 5698 7654 32", "GB82WEST12345698765432", "gb82 west 1234 5698 7654 32"],
        "secret": ["AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghijklmnopqrstuvwxyz", "Bearer abcdefghijklmnopqrstuvwxyz", "sk_" + "test_abcdefghijklmnopqrstuvwxyz"],  # split so secret scanners skip the synthetic key
        "name": ["Alice Example", "Bob Sample"],
        "street_address": ["42 Fictional Lane, Example City"],
    }
    templates = ["Refund DEMO-2048: {}. Continue review.", "Résumé — {} — synthetic only.", '{{"value":"{}","status":"pending"}}', "Reference\n{}\nContinue"]
    for label, values in positives.items():
        for index in range(40):
            value = rng.choice(values)
            text = rng.choice(templates).format(value)
            yield {"uid": f"generated-{label}-{index}", "text": text, "entities": [{"entity": value, "types": [label]}]}
    negatives = ["4111 1111 1111 1112", "SKU15550100100", "0000 0000 0000 0000", "Order DEMO-2048 costs USD 42.00", "Build 2026.10.02", "Inventory reference 5550100100"]
    for index in range(120):
        yield {"uid": f"negative-{index}", "text": rng.choice(negatives), "entities": []}

def evaluate(binary, rows, source, model=None, penalty=2):
    process = subprocess.Popen([str(binary)] + (["--model", str(model), str(penalty)] if model else []), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    stats = defaultdict(lambda: {"entities": 0, "fully_masked": 0, "partly_masked": 0, "missed": 0})
    examples = defaultdict(list)
    latencies = []
    documents = predictions = unmatched_predictions = missing_annotations = negative_documents = negative_changed = 0
    try:
        for row in rows:
            documents += 1
            text = row["text"]
            entities = row["entities"]
            if isinstance(entities, str):
                entities = ast.literal_eval(entities)
            truth = set()
            for entity in entities:
                found = list(occurrences(text, entity["entity"]))
                if not found:
                    missing_annotations += 1
                for label in entity["types"]:
                    truth.update((label, start, end) for start, end in found)
            process.stdin.write(json.dumps({"text": text}) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            ranges = response["ranges"]
            latencies.append(response["micros"])
            predictions += len(ranges)
            unmatched_predictions += sum(not any(start < b and end > a for _, a, b in truth) for start, end in ranges)
            if not entities:
                negative_documents += 1
                negative_changed += bool(ranges)
            for label, start, end in sorted(truth):
                stats[label]["entities"] += 1
                full = any(a <= start and b >= end for a, b in ranges)
                partial = not full and any(a < end and b > start for a, b in ranges)
                stats[label]["fully_masked" if full else "partly_masked" if partial else "missed"] += 1
                if not full and len(examples[label]) < 5:
                    examples[label].append({"uid": row["uid"], "entity": text[start:end], "context": text[max(0,start-35):min(len(text),end+35)], "partial": partial})
        process.stdin.close()
        if process.wait(timeout=10) != 0:
            raise RuntimeError("Rust detector evaluation failed")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
    for label, counts in stats.items():
        counts["full_span_recall"] = counts["fully_masked"] / counts["entities"]
        counts["v1_pattern_category"] = label in SUPPORTED_LABELS
    ordered = sorted(latencies)
    return {"source": source, "documents": documents, "per_type": dict(sorted(stats.items())),
            "detected_spans": predictions, "unmatched_detector_spans": unmatched_predictions,
            "annotations_not_present_in_text": missing_annotations,
            "negative_documents": negative_documents, "negative_documents_changed": negative_changed,
            "detector_microseconds": {"median": statistics.median(ordered), "p95": ordered[int(.95*(len(ordered)-1))], "max": max(ordered)},
            "failure_examples": dict(examples)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Download the pinned synthetic test split")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--model", type=Path, help="Use the real local OpenAI ONNX model plus patterns")
    parser.add_argument("--penalty", type=float, default=2, help="Background penalty; defaults to the application's operating point")
    parser.add_argument("--limit", type=int, default=0, help="Development subset only; final evaluation uses all documents")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/pii-dataset")
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    parquet = output / "gretel-test.parquet"
    url = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/{FILE}"
    if args.download:
        with urllib.request.urlopen(url, timeout=60) as response, parquet.open("wb") as file:
            while chunk := response.read(1024 * 1024):
                file.write(chunk)
    if not parquet.exists():
        raise SystemExit("No cached dataset. Use --download once; subsequent runs are offline.")
    if hashlib.sha256(parquet.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("Cached dataset checksum differs from the pinned synthetic test split")
    import pyarrow.parquet as pq
    if not args.skip_build:
        subprocess.run(["cargo", "build", "--release", "--example", "pii_eval"], cwd=ROOT, check=True)
    binary = ROOT / "target/release/examples/pii_eval"
    def rows():
        seen = 0
        for batch in pq.ParquetFile(parquet).iter_batches(batch_size=128, columns=["uid", "text", "entities"]):
            for row in batch.to_pylist():
                if args.limit and seen >= args.limit: return
                seen += 1
                yield row
    manifest = {"dataset": DATASET, "revision": REVISION, "file": FILE, "license": "Apache-2.0",
                "sha256": hashlib.sha256(parquet.read_bytes()).hexdigest(), "synthetic_provenance": f"https://huggingface.co/datasets/{DATASET}"}
    summary = {"manifest": manifest, "detector": {"model": "openai/privacy-filter" if args.model else None, "background_penalty": args.penalty, "development_limit": args.limit}, "external_test": evaluate(binary, rows(), DATASET, args.model, args.penalty),
               "generated_controls": evaluate(binary, generated_controls(), "seed=2048; synthetic formats and negative controls", args.model, args.penalty),
               "method": "Complete entity span must be covered by one replacement. Partial coverage fails recall. All annotated types/formats are reported; no unsupported types or invalid checksum examples are hidden. Unmatched spans are not automatically false positives: annotations can be incomplete. Text-detector evaluation excludes OCR errors; the separate native screen test covers OCR and video."}
    (output / ("evaluation-model.json" if args.model else "evaluation.json")).write_text(json.dumps(summary, indent=2) + "\n")
    for label, counts in summary["external_test"]["per_type"].items():
        if counts["v1_pattern_category"] or label in {"name", "street_address"}:
            print(f"{label}: {counts['fully_masked']}/{counts['entities']} fully masked ({100*counts['full_span_recall']:.1f}%)")
    print(f"Evidence: {output / ('evaluation-model.json' if args.model else 'evaluation.json')}")

if __name__ == "__main__":
    main()
