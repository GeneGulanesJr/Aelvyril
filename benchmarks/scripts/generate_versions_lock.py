"""
Auto-generate benchmarks/versions.lock from the current environment.

Fills in missing SHA/commit values and package versions by inspecting:
  - Python runtime version
  - Rust toolchain version
  - Installed pip packages
  - Git commit SHAs for cloned benchmark repos
  - spaCy model checksum

Usage:
    python benchmarks/scripts/generate_versions_lock.py
    python benchmarks/scripts/generate_versions_lock.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


LOCK_PATH = Path("benchmarks/versions.lock")


def _run(cmd: list[str]) -> str | None:
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None


def _python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"


def _rust_version() -> str | None:
    out = _run(["rustc", "--version"])
    if out:
        parts = out.split()
        return parts[1] if len(parts) >= 2 else out
    return None


def _pip_version(package: str) -> str | None:
    out = _run([sys.executable, "-m", "pip", "show", package])
    if not out:
        return None
    for line in out.splitlines():
        if line.startswith("Version:"):
            return line.split(":", 1)[1].strip()
    return None


def _git_sha(repo_dir: str | Path) -> str | None:
    return _run(["git", "-C", str(repo_dir), "rev-parse", "HEAD"])


def _spacy_model_version(name: str) -> tuple[str | None, str | None]:
    try:
        import spacy
        model = spacy.load(name)
        version = model.meta.get("version")
        # Try to locate model path for checksum
        path = model.path if hasattr(model, "path") else None
        if path and os.path.isdir(path):
            md5 = _dir_md5(path)
            return version, md5
        return version, None
    except Exception:
        return None, None


def _dir_md5(root: str | Path) -> str:
    """Compute a deterministic hash of a directory's contents."""
    hashes = []
    for dirpath, _dirnames, filenames in sorted(os.walk(root)):
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, "rb") as f:
                    hashes.append(hashlib.md5(f.read()).hexdigest())
            except Exception:
                pass
    combined = "".join(hashes)
    return hashlib.md5(combined.encode()).hexdigest()


def generate_lock(check_only: bool = False) -> dict:
    lock: dict = {}
    if LOCK_PATH.exists():
        with open(LOCK_PATH) as f:
            lock = json.load(f)

    # Python
    lock["python"] = _python_version()

    # Rust
    rust = _rust_version()
    if rust:
        lock["rust"] = rust

    # Packages
    presidio_ver = _pip_version("presidio-analyzer")
    if presidio_ver:
        lock["presidio_analyzer"] = presidio_ver

    faker_ver = _pip_version("faker")
    if faker_ver:
        lock["faker"] = faker_ver

    # spaCy model
    spacy_name = lock.get("spacy_model", {}).get("name", "en_core_web_lg")
    spacy_ver, spacy_md5 = _spacy_model_version(spacy_name)
    lock["spacy_model"] = {
        "name": spacy_name,
        "version": spacy_ver or lock.get("spacy_model", {}).get("version", "TBD"),
        "md5": spacy_md5 or lock.get("spacy_model", {}).get("md5", "TBD"),
    }

    # Git SHAs for cloned repos
    repo_dirs = {
        "presidio_research": "benchmarks/presidio_research/presidio-research",
        "pii_bench": "benchmarks/pii_bench/PII-Bench",
        "tab": "benchmarks/tab/text-anonymization-benchmark",
    }
    for key, rel_dir in repo_dirs.items():
        repo_path = Path(rel_dir)
        if repo_path.exists():
            sha = _git_sha(repo_path)
            if key not in lock:
                lock[key] = {}
            if isinstance(lock[key], dict):
                if sha and lock[key].get("commit") in (None, "", "TBD"):
                    lock[key]["commit"] = sha
                if sha and lock[key].get("sha256") in (None, "", "TBD"):
                    lock[key]["sha256"] = sha

    if check_only:
        return lock

    with open(LOCK_PATH, "w") as f:
        json.dump(lock, f, indent=2)
    print(f"[OK] versions.lock updated -> {LOCK_PATH.resolve()}")
    return lock


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate or check versions.lock")
    parser.add_argument("--check", action="store_true", help="Read-only check")
    args = parser.parse_args()

    lock = generate_lock(check_only=args.check)

    missing = []
    for key, val in lock.items():
        if isinstance(val, dict):
            for subkey, subval in val.items():
                if subval in ("TBD", None, ""):
                    missing.append(f"{key}.{subkey}")
        elif val in ("TBD", None, ""):
            missing.append(key)

    if missing:
        print(f"[WARN] {len(missing)} fields still missing: {', '.join(missing)}")
    else:
        print("[OK] All version fields populated.")


if __name__ == "__main__":
    main()
