#!/usr/bin/env python3
"""Read-only integrity checks for this documentation handoff package."""

from pathlib import Path
import hashlib
import json
import math
import re
import sys
from urllib.parse import unquote, urlsplit


def main():
    root = Path(__file__).resolve().parents[1]
    failures = []
    manifest_path = root / "evidence/package-manifest.json"
    if not manifest_path.exists():
        print("FAIL: evidence/package-manifest.json is missing")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = manifest["files"]
    seen = set()
    for record in records:
        relative = record["path"]
        path = (root / relative).resolve()
        if root not in path.parents or relative in seen:
            failures.append("invalid or duplicate manifest path: " + relative)
            continue
        seen.add(relative)
        if not path.is_file():
            failures.append("missing: " + relative)
            continue
        content = path.read_bytes()
        if len(content) != record["bytes"]:
            failures.append("size mismatch: " + relative)
        if hashlib.sha256(content).hexdigest() != record["sha256"]:
            failures.append("hash mismatch: " + relative)

    json_count = 0
    link_count = 0
    markdown_count = 0
    for relative in sorted(seen):
        path = root / relative
        if not path.is_file():
            continue
        if path.suffix == ".json":
            json_count += 1
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, UnicodeError) as error:
                failures.append("invalid JSON: " + relative + ": " + str(error))
        if path.suffix != ".md":
            continue
        markdown_count += 1
        content = path.read_text(encoding="utf-8")
        if sum(line.startswith("```") for line in content.splitlines()) % 2:
            failures.append("unbalanced code fences: " + relative)
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", content):
            parsed = urlsplit(target.strip("<>"))
            if parsed.scheme or not parsed.path:
                continue
            link_count += 1
            destination = (path.parent / unquote(parsed.path)).resolve()
            if not destination.exists():
                failures.append("broken link in " + relative + ": " + target)

    try:
        policy = json.loads((root / "spec/policy-v0.proposed.json").read_text())
        params = policy["parameters"]
        assert policy["status"] == "research_hypothesis_not_validated"
        assert params["warmupBars"] == params["impulseBars"] + params["baselineBars"]
        assert 0 < params["pullbackMin"] < params["pullbackMax"] < 1
        assert params["confirmationBars"] <= params["confirmationWindowBars"]
        assert math.ceil(params["baselineBars"] * params["minPositiveVolumeFraction"]) == 231
        assert params["setupTtlHours"] + 24 == 96
    except (ValueError, KeyError, AssertionError) as error:
        failures.append("proposed policy consistency check failed: " + str(error))

    if failures:
        for failure in failures:
            print("FAIL: " + failure)
        return 1
    print("PASS: {} files match the manifest".format(len(records)))
    print("PASS: {} Markdown files, {} relative links, {} JSON files".format(
        markdown_count, link_count, json_count))
    print("PASS: proposed policy structural consistency")
    print("Scope: local documentation only; no network, application or strategy tests")
    return 0


if __name__ == "__main__":
    sys.exit(main())
