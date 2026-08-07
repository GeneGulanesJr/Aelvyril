# Aelvyril Presidio + Liquid LFM2.5 encoder sidecar.
#
# Endpoints:
#   GET  /health              -> 200 { "status": "ok", "presidio": true, "pii": bool, "policy": bool }
#   POST /analyze             -> Presidio PII detection (existing contract)
#   POST /liquid/pii          -> Liquid LFM2.5-Encoder-350M-PII-Detector (token classification)
#   POST /liquid/policy       -> Liquid LFM2.5-Encoder-350M-Policy-Linter (zero-shot rule matching)
#
# Models are auto-downloaded on first request from Hugging Face into ~/.aelvyril/models.
# Heavy dependencies (torch, transformers) are imported lazily so the Presidio path stays
# fast even when the Liquid models are disabled or unreachable.
#
# Env vars:
#   PRESIDIO_HOST (default 127.0.0.1), PRESIDIO_PORT (default 3000)
#   AELVYRIL_PRESIDIO_HOST / AELVYRIL_PRESIDIO_PORT (legacy alias)
#   AELVYRIL_LIQUID_PII_ENABLED   (1 to enable, default 0)
#   AELVYRIL_LIQUID_POLICY_ENABLED (1 to enable, default 0)
#   AELVYRIL_LIQUID_MODEL_DIR     (override model cache dir, default ~/.aelvyril/models)
#   AELVYRIL_LIQUID_PII_REPO      (default LiquidAI/LFM2.5-Encoder-350M-PII-Detector)
#   AELVYRIL_LIQUID_POLICY_REPO   (default LiquidAI/LFM2.5-Encoder-350M-Policy-Linter)

import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── Configuration ─────────────────────────────────────────────────────────────

HOST = os.environ.get("PRESIDIO_HOST") or os.environ.get("AELVYRIL_PRESIDIO_HOST") or "127.0.0.1"
PORT = int(
    os.environ.get("PRESIDIO_PORT")
    or os.environ.get("AELVYRIL_PRESIDIO_PORT")
    or "3000"
)

LIQUID_PII_ENABLED = os.environ.get("AELVYRIL_LIQUID_PII_ENABLED", "0") == "1"
LIQUID_POLICY_ENABLED = os.environ.get("AELVYRIL_LIQUID_POLICY_ENABLED", "0") == "1"
LIQUID_MODEL_DIR = os.environ.get(
    "AELVYRIL_LIQUID_MODEL_DIR",
    os.path.join(os.path.expanduser("~"), ".aelvyril", "models"),
)
LIQUID_PII_REPO = os.environ.get(
    "AELVYRIL_LIQUID_PII_REPO", "LiquidAI/LFM2.5-Encoder-350M-PII-Detector"
)
LIQUID_POLICY_REPO = os.environ.get(
    "AELVYRIL_LIQUID_POLICY_REPO", "LiquidAI/LFM2.5-Encoder-350M-Policy-Linter"
)
PII_THRESHOLD = float(os.environ.get("AELVYRIL_LIQUID_PII_THRESHOLD", "0.5"))
POLICY_THRESHOLD = float(os.environ.get("AELVYRIL_LIQUID_POLICY_THRESHOLD", "0.5"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("aelvyril-sidecar")


# ── Lazy Liquid model loaders ────────────────────────────────────────────────

class _LiquidState:
    """Thread-safe lazy loaders for the Liquid encoder models."""

    def __init__(self) -> None:
        self.pii_lock = threading.Lock()
        self.policy_lock = threading.Lock()
        self.pii_loaded = False
        self.policy_loaded = False
        self.pii_error: str | None = None
        self.policy_error: str | None = None

    def _ensure_dir(self) -> None:
        os.makedirs(LIQUID_MODEL_DIR, exist_ok=True)

    def _snapshot(self, repo: str) -> str:
        """Download model files via huggingface_hub and return the snapshot dir."""
        try:
            from huggingface_hub import snapshot_download  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "huggingface_hub is required for Liquid models (pip install huggingface_hub)"
            ) from e
        self._ensure_dir()
        log.info("Downloading %s into %s", repo, LIQUID_MODEL_DIR)
        return snapshot_download(
            repo_id=repo,
            local_dir=os.path.join(LIQUID_MODEL_DIR, repo.replace("/", "--")),
            allow_patterns=[
                "*.json",
                "*.txt",
                "*.safetensors",
                "tokenizer.*",
                "*.py",
                "*.md",
            ],
        )

    def get_pii(self):
        """Return (tokenizer, model, hybrid_decode_fn) or raise."""
        if not LIQUID_PII_ENABLED:
            raise RuntimeError("Liquid PII encoder is disabled")
        if self.pii_loaded:
            return self._pii
        with self.pii_lock:
            if self.pii_loaded:
                return self._pii
            try:
                import importlib.util
                import sys as _sys

                import torch  # type: ignore
                from transformers import AutoModelForTokenClassification, AutoTokenizer  # type: ignore

                repo_dir = self._snapshot(LIQUID_PII_REPO)
                helper_path = os.path.join(repo_dir, "pii_hybrid_decode.py")
                if not os.path.exists(helper_path):
                    raise FileNotFoundError(f"pii_hybrid_decode.py not found in {repo_dir}")

                spec = importlib.util.spec_from_file_location("pii_hybrid_decode", helper_path)
                hd = importlib.util.module_from_spec(spec)
                _sys.modules["pii_hybrid_decode"] = hd
                spec.loader.exec_module(hd)  # type: ignore

                tok = AutoTokenizer.from_pretrained(repo_dir, trust_remote_code=True)
                model = AutoModelForTokenClassification.from_pretrained(
                    repo_dir, trust_remote_code=True
                ).eval()
                self._pii = (tok, model, hd)
                self.pii_loaded = True
                log.info("Liquid PII encoder loaded from %s", repo_dir)
                return self._pii
            except Exception as e:  # noqa: BLE001
                self.pii_error = str(e)
                log.exception("Failed to load Liquid PII encoder")
                raise

    def get_policy(self):
        if not LIQUID_POLICY_ENABLED:
            raise RuntimeError("Liquid policy linter is disabled")
        if self.policy_loaded:
            return self._policy
        with self.policy_lock:
            if self.policy_loaded:
                return self._policy
            try:
                import importlib.util
                import sys as _sys

                import torch  # type: ignore
                from transformers import AutoTokenizer  # type: ignore

                repo_dir = self._snapshot(LIQUID_POLICY_REPO)
                # The model repo ships Lfm2BidirForRuleMatching in
                # modeling_bizlint_rule_matching.py; the README's
                # train_bizlint_v02.py import is training-repo code that is not
                # part of the snapshot. Try both names for forward/back compat.
                train_file = next(
                    (
                        os.path.join(repo_dir, cand)
                        for cand in ("modeling_bizlint_rule_matching.py", "train_bizlint_v02.py")
                        if os.path.exists(os.path.join(repo_dir, cand))
                    ),
                    None,
                )
                if train_file is None:
                    raise FileNotFoundError(
                        f"no model module (modeling_bizlint_rule_matching.py / train_bizlint_v02.py) in {repo_dir}"
                    )

                # Stage the model's .py files into an importable package so the
                # module's relative import (from .modeling_lfm2_bidirectional
                # import ...) resolves. spec_from_file_location() loads modules
                # without a parent package and breaks on relative imports.
                import tempfile
                import shutil

                pkg_name = "liquid_policy_model"
                pkg_dir = os.path.join(tempfile.gettempdir(), pkg_name)
                os.makedirs(pkg_dir, exist_ok=True)
                for fn in os.listdir(repo_dir):
                    if fn.endswith(".py"):
                        shutil.copy(os.path.join(repo_dir, fn), os.path.join(pkg_dir, fn))
                init_py = os.path.join(pkg_dir, "__init__.py")
                if not os.path.exists(init_py):
                    open(init_py, "a").close()
                parent = os.path.dirname(pkg_dir)
                if parent not in _sys.path:
                    _sys.path.insert(0, parent)

                main_module = (
                    "modeling_bizlint_rule_matching"
                    if train_file.endswith("modeling_bizlint_rule_matching.py")
                    else "train_bizlint_v02"
                )
                m = importlib.import_module(f"{pkg_name}.{main_module}")

                tok = AutoTokenizer.from_pretrained(repo_dir, trust_remote_code=True)
                model_cls = getattr(m, "Lfm2BidirForRuleMatching")
                model = model_cls.from_pretrained(repo_dir, trust_remote_code=True).eval()
                self._policy = (tok, model)
                self.policy_loaded = True
                log.info("Liquid Policy linter loaded from %s", repo_dir)
                return self._policy
            except Exception as e:  # noqa: BLE001
                self.policy_error = str(e)
                log.exception("Failed to load Liquid Policy linter")
                raise


_STATE = _LiquidState()


# ── Presidio analyzer ────────────────────────────────────────────────────────

_presidio = None
_presidio_lock = threading.Lock()


def get_presidio():
    """Lazy-init Microsoft Presidio AnalyzerEngine with the spaCy small English model."""
    global _presidio
    if _presidio is not None:
        return _presidio
    with _presidio_lock:
        if _presidio is not None:
            return _presidio
        try:
            from presidio_analyzer import AnalyzerEngine  # type: ignore
            from presidio_analyzer.nlp_engine import NlpEngineProvider  # type: ignore
        except ImportError as e:
            raise RuntimeError(f"presidio-analyzer not available: {e}") from e
        try:
            # Default AnalyzerEngine() uses en_core_web_lg (a ~600 MB download
            # on first init). Our requirements pin the small model — wire it
            # explicitly so first init is fast and offline-friendly.
            provider = NlpEngineProvider(
                nlp_configuration={
                    "nlp_engine_name": "spacy",
                    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
                }
            )
            _presidio = AnalyzerEngine(nlp_engine=provider.create_engine())
        except Exception as e:  # noqa: BLE001
            log.warning("Presidio init failed: %s", e)
            raise
        return _presidio


def presidio_analyze(text: str, language: str, entities: list[str], score_threshold: float) -> list[dict]:
    engine = get_presidio()
    kwargs = {"language": language, "score_threshold": score_threshold}
    if entities:
        kwargs["entities"] = entities
    results = engine.analyze(text=text, **kwargs)
    out = []
    for r in results:
        out.append(
            {
                "entity_type": str(r.entity_type),
                "start": int(r.start),
                "end": int(r.end),
                "score": float(r.score),
            }
        )
    return out


# ── Liquid PII analyze ───────────────────────────────────────────────────────

def liquid_pii_analyze(text: str) -> list[dict]:
    tok, model, hd = _STATE.get_pii()
    # The model repo's pii_hybrid_decode.predict(text, tok, model, hybrid=True)
    # takes no threshold kwarg and returns spans as {start, end, type, text}
    # (no per-span score) — match its actual API.
    spans = hd.predict(text, tok, model)
    out = []
    for s in spans:
        out.append(
            {
                "entity_type": str(s.get("type") or s.get("label") or s.get("entity_type") or "UNKNOWN"),
                "start": int(s.get("start", 0)),
                "end": int(s.get("end", 0)),
                # Hybrid decode emits no confidence; treat model-detected
                # spans as confident (1.0).
                "score": float(s.get("score", 1.0)),
            }
        )
    return out


# ── Liquid Policy analyze ────────────────────────────────────────────────────

def liquid_policy_analyze(text: str, rules: list[dict]) -> list[dict]:
    """Zero-shot rule matching against `rules`. Each rule: {text, action}."""
    import torch  # type: ignore

    tok, model = _STATE.get_policy()
    active_rules = [r for r in rules if r.get("text") and r.get("action") in ("warn", "block")]
    if not active_rules:
        return []

    rule_texts = [str(r["text"]) for r in active_rules]
    prefix = "Policy:\n" + "\n".join(f"- {r}" for r in rule_texts) + "\n\nText:\n"
    full_text = prefix + text

    enc = tok(full_text, return_offsets_mapping=True, return_tensors="pt")
    offsets = enc.pop("offset_mapping")[0].tolist()

    rule_pool = torch.zeros(1, len(rule_texts), len(offsets))
    pos = len("Policy:\n")
    for rule_idx, rule in enumerate(rule_texts):
        start = pos + 2
        end = start + len(rule)
        token_idxs = [i for i, (a, b) in enumerate(offsets) if a < end and b > start and a != b]
        if token_idxs:
            rule_pool[0, rule_idx, token_idxs] = 1.0 / len(token_idxs)
        pos = end + 1

    with torch.no_grad():
        probs = model(**enc, rule_pool=rule_pool)["logits"].sigmoid()[0]

    text_start = len(prefix)
    out = []
    for token_idx, (a, b) in enumerate(offsets):
        if b <= text_start or a == b:
            continue
        token_text = full_text[a:b]
        for rule_idx, prob in enumerate(probs[token_idx]):
            score = float(prob.item())
            if score > POLICY_THRESHOLD:
                out.append(
                    {
                        "rule_index": rule_idx,
                        "rule_text": rule_texts[rule_idx],
                        "action": active_rules[rule_idx]["action"],
                        "token_text": token_text,
                        "start": int(a - text_start),
                        "end": int(b - text_start),
                        "score": score,
                    }
                )
    return out


# ── HTTP handler ─────────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    server_version = "AelvyrilSidecar/1.0"

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        log.info("%s - %s", self.address_string(), format % args)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    # ── GET /health ────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(
                200,
                {
                    "status": "ok",
                    "presidio": True,
                    "pii": LIQUID_PII_ENABLED and _STATE.pii_loaded,
                    "policy": LIQUID_POLICY_ENABLED and _STATE.policy_loaded,
                    "pii_error": _STATE.pii_error,
                    "policy_error": _STATE.policy_error,
                },
            )
            return
        self._json(404, {"error": "not_found"})

    # ── POST endpoints ─────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._read_body()
            if self.path == "/analyze":
                text = body.get("text", "")
                language = body.get("language", "en")
                entities = body.get("entities") or []
                score_threshold = float(body.get("score_threshold", 0.5))
                result = presidio_analyze(text, language, entities, score_threshold)
                self._json(200, {"result": result})
                return
            if self.path == "/liquid/pii":
                text = body.get("text", "")
                if not LIQUID_PII_ENABLED:
                    self._json(403, {"error": "liquid_pii_disabled"})
                    return
                result = liquid_pii_analyze(text)
                self._json(200, {"result": result})
                return
            if self.path == "/liquid/policy":
                text = body.get("text", "")
                rules = body.get("rules") or []
                if not LIQUID_POLICY_ENABLED:
                    self._json(403, {"error": "liquid_policy_disabled"})
                    return
                result = liquid_policy_analyze(text, rules)
                self._json(200, {"violations": result})
                return
            self._json(404, {"error": "not_found"})
        except Exception as e:  # noqa: BLE001
            log.exception("Handler error")
            self._json(500, {"error": str(e)})


# ── Entry point ─────────────────────────────────────────────────────────────

def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), _Handler)
    log.info("Aelvyril sidecar listening on http://%s:%d", HOST, PORT)
    log.info(
        "Endpoints: /health, /analyze, /liquid/pii(enabled=%s), /liquid/policy(enabled=%s)",
        LIQUID_PII_ENABLED,
        LIQUID_POLICY_ENABLED,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()