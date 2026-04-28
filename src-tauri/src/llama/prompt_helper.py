#!/usr/bin/env python3
"""
Prompt formatter for LFM2.5-350M using its HuggingFace chat template.

Called synchronously from Rust (LlamaDetector::build_prompt).
Arguments:
  1. model_dir — path to the model directory (contains tokenizer.json, tokenizer_config.json, chat_template.jinja)
  2. user_text — the text to analyze for PII

Environment:
  SYSTEM_PROMPT — the system instruction (passed separately to avoid hardcoding in Rust)

Prints the fully formatted prompt to stdout.
Exit code 0 on success, 1 on error (Rust falls back to ChatML).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: prompt_helper.py <model_dir> <user_text>", file=sys.stderr)
        return 1

    model_dir = Path(sys.argv[1])
    user_text = sys.argv[2]
    system_prompt = os.environ.get("SYSTEM_PROMPT", "")

    if not system_prompt:
        print("ERROR: SYSTEM_PROMPT environment variable not set", file=sys.stderr)
        return 1

    # Load tokenizer to get special token strings (bos_token, eos_token)
    try:
        from tokenizers import Tokenizer
    except ImportError:
        print("ERROR: tokenizers library not installed", file=sys.stderr)
        return 1

    tokenizer_path = model_dir / "tokenizer.json"
    if not tokenizer_path.exists():
        print(f"ERROR: tokenizer.json not found at {tokenizer_path}", file=sys.stderr)
        return 1

    try:
        tok = Tokenizer.from_file(str(tokenizer_path))
    except Exception as e:
        print(f"ERROR: failed to load tokenizer from '{tokenizer_path}': {e}", file=sys.stderr)
        return 1

    # Load tokenizer_config.json for special token IDs/strings
    config_path = model_dir / "tokenizer_config.json"
    if not config_path.exists():
        print(f"ERROR: tokenizer_config.json not found at {config_path}", file=sys.stderr)
        return 1

    try:
        with open(config_path) as f:
            tokenizer_config = json.load(f)
    except Exception as e:
        print(f"ERROR: failed to read tokenizer_config.json: {e}", file=sys.stderr)
        return 1

    # Resolve BOS/EOS token strings from config or tokenizer
    bos_token = tokenizer_config.get("bos_token", "")
    eos_token = tokenizer_config.get("eos_token", "")
    # If not explicit strings, try to get token ID then decode
    if not bos_token or not eos_token:
        try:
            bos_id = tokenizer_config.get("bos_token_id")
            eos_id = tokenizer_config.get("eos_token_id")
            if bos_id is not None:
                bos_token = tok.decode([bos_id])
            if eos_id is not None:
                eos_token = tok.decode([eos_id])
        except Exception:
            pass  # fall back to plain strings

    # Load the chat template (prefer explicit file, fall back to config)
    template_path = model_dir / "chat_template.jinja"
    if template_path.exists():
        with open(template_path) as f:
            chat_template = f.read()
    else:
        chat_template = tokenizer_config.get("chat_template", "")
        if not chat_template:
            print("ERROR: no chat_template found (missing chat_template.jinja or chat_template field in config)", file=sys.stderr)
            return 1

    # Render the template using Jinja2
    try:
        from jinja2 import Template
    except ImportError:
        print("ERROR: jinja2 library not installed", file=sys.stderr)
        return 1

    tmpl = Template(chat_template)
    try:
        prompt = tmpl.render(
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_text}],
            bos_token=bos_token,
            eos_token=eos_token,
            add_generation_prompt=True,
        )
    except Exception as e:
        print(f"ERROR: template rendering failed: {e}", file=sys.stderr)
        return 1

    print(prompt, end="")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
