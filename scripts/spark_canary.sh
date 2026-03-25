#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPARK_SSH="$ROOT_DIR/scripts/spark_ssh.sh"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="${1:-$ROOT_DIR/artifacts/spark-canary/$STAMP}"
TURNS="${SPARK_CANARY_TURNS:-8}"
SPARK_HOST="${SPARK_HOST:-192.168.1.93}"
SPARK_USER="${SPARK_USER:-dgx-aii}"
SPARK_KEY="${SPARK_KEY_PATH:-$HOME/.ssh/jarvis_full_host_ed25519}"
SPARK_KNOWN_HOSTS="${SPARK_KNOWN_HOSTS:-$HOME/.ssh/known_hosts_dgx_spark_tool}"

if ! [[ "$TURNS" =~ ^[0-9]+$ ]] || (( TURNS <= 0 )); then
  echo "Invalid SPARK_CANARY_TURNS: must be a positive integer (got: $TURNS)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
RUN_ID="$(date +%s)-$$-${RANDOM:-0}"
R_SHORT_CSV="/tmp/spark-canary-short-${RUN_ID}.csv"
R_SHORT_SUMMARY="/tmp/spark-canary-short-summary-${RUN_ID}.json"
R_SHORT_LOG="/tmp/spark-canary-short-${RUN_ID}.log"
R_STREAM_DIR="/tmp/spark-canary-stream-${RUN_ID}"
R_STREAM_RUNNER="${R_STREAM_DIR}/run_stream_benchmark.py"
R_STREAM_CSV="${R_STREAM_DIR}/voice_stream_results.csv"
R_STREAM_SUMMARY="${R_STREAM_DIR}/voice_stream_summary.json"
R_STREAM_LOG="${R_STREAM_DIR}/spark-canary-stream.log"

# 1) Baseline health snapshot
"$ROOT_DIR/scripts/spark_maint.sh" health > "$OUT_DIR/health.json"

# 2) RAG canary (embeddings + qdrant + reranker health)
"$SPARK_SSH" -- '
python3 - <<"PY"
import json, time, urllib.request
from urllib.error import URLError, HTTPError

def get_json(url, timeout=5):
    req = urllib.request.Request(url, headers={"accept":"application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body[:200]
        return int(r.status), parsed

def post_json(url, payload, timeout=8):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"content-type":"application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body[:200]
        return int(r.status), parsed

out = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

try:
    t0 = time.perf_counter()
    st, emb = post_json("http://127.0.0.1:8081/v1/embeddings", {"input":"spark canary embedding"}, timeout=8)
    dt = (time.perf_counter() - t0) * 1000
    dim = None
    if isinstance(emb, dict) and emb.get("data") and isinstance(emb["data"], list):
        vec = emb["data"][0].get("embedding") if emb["data"] else None
        if isinstance(vec, list):
            dim = len(vec)
    out["embeddings"] = {"ok": st == 200, "status": st, "dim": dim, "latency_ms": round(dt, 1)}
except Exception as e:
    out["embeddings"] = {"ok": False, "error": str(e)}

for name, url in [
    ("qdrant_collections", "http://127.0.0.1:6333/collections"),
    ("reranker_health", "http://127.0.0.1:9003/health"),
]:
    try:
        st, body = get_json(url, timeout=5)
        out[name] = {"ok": st == 200, "status": st, "body_preview": body if isinstance(body, dict) else str(body)[:180]}
    except Exception as e:
        out[name] = {"ok": False, "error": str(e)}

print(json.dumps(out, indent=2))
PY
' > "$OUT_DIR/rag-canary.json"

# 3) Voice canary benchmarks (short runs)
"$SPARK_SSH" -- "set -euo pipefail; \
  BENCH_TURNS=$TURNS BENCH_CSV='$R_SHORT_CSV' BENCH_SUMMARY_JSON='$R_SHORT_SUMMARY' \
  python3 /home/dgx-aii/openclaw-deploy/benchmarks/run_voice_short_turn.py >'$R_SHORT_LOG' 2>&1; \
  mkdir -p '$R_STREAM_DIR'; \
  cp /home/dgx-aii/openclaw-deploy/benchmarks/run_stream_benchmark.py '$R_STREAM_RUNNER'; \
  BENCH_TURNS=$TURNS python3 '$R_STREAM_RUNNER' >'$R_STREAM_LOG' 2>&1"

REMOTE_SRCS=(
  "$R_SHORT_CSV"
  "$R_SHORT_SUMMARY"
  "$R_STREAM_CSV"
  "$R_STREAM_SUMMARY"
  "$R_SHORT_LOG"
  "$R_STREAM_LOG"
)
LOCAL_DSTS=(
  "$OUT_DIR/voice-short.csv"
  "$OUT_DIR/voice-short-summary.json"
  "$OUT_DIR/voice-stream.csv"
  "$OUT_DIR/voice-stream-summary.json"
  "$OUT_DIR/voice-short.log"
  "$OUT_DIR/voice-stream.log"
)

for i in "${!REMOTE_SRCS[@]}"; do
  scp -i "$SPARK_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$SPARK_KNOWN_HOSTS" \
    "$SPARK_USER@$SPARK_HOST:${REMOTE_SRCS[$i]}" "${LOCAL_DSTS[$i]}" >/dev/null
done

"$SPARK_SSH" -- "rm -rf '$R_STREAM_DIR' '$R_SHORT_CSV' '$R_SHORT_SUMMARY' '$R_SHORT_LOG' >/dev/null 2>&1 || true"

python3 - "$OUT_DIR" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
summary = out / "SUMMARY.md"
health = json.loads((out / "health.json").read_text())
rag = json.loads((out / "rag-canary.json").read_text())
short = json.loads((out / "voice-short-summary.json").read_text())
stream = json.loads((out / "voice-stream-summary.json").read_text())

lines = []
lines.append("# Spark Canary Summary")
lines.append("")
lines.append(f"Artifact: `{out}`")
lines.append("")
lines.append("## Health")
for k, v in health.items():
    ok = v.get("ok") if isinstance(v, dict) else None
    lines.append(f"- {k}: {'ok' if ok else 'fail'}")
lines.append("")
lines.append("## RAG canary")
lines.append(f"- embeddings ok: {rag.get('embeddings',{}).get('ok')} dim={rag.get('embeddings',{}).get('dim')} latency_ms={rag.get('embeddings',{}).get('latency_ms')}")
lines.append(f"- qdrant collections ok: {rag.get('qdrant_collections',{}).get('ok')}")
lines.append(f"- reranker health ok: {rag.get('reranker_health',{}).get('ok')}")
lines.append("")
lines.append("## Voice short-turn")
p = short.get("p50_p95", {})
if isinstance(p, dict):
    lines.append(f"- STT p50/p95: {p.get('stt_total_ms',{}).get('p50')} / {p.get('stt_total_ms',{}).get('p95')} ms")
    lines.append(f"- TTS first-byte p50/p95: {p.get('tts_first_byte_ms',{}).get('p50')} / {p.get('tts_first_byte_ms',{}).get('p95')} ms")
    lines.append(f"- TTS full p50/p95: {p.get('tts_full_completion_ms',{}).get('p50')} / {p.get('tts_full_completion_ms',{}).get('p95')} ms")
lines.append("")
lines.append("## Voice stream")
sp = stream.get("p50_p95", {})
if isinstance(sp, dict):
    lines.append(f"- stream first-byte p50/p95: {sp.get('stream_first_byte_ms',{}).get('p50')} / {sp.get('stream_first_byte_ms',{}).get('p95')} ms")
    lines.append(f"- stream full p50/p95: {sp.get('stream_full_completion_ms',{}).get('p50')} / {sp.get('stream_full_completion_ms',{}).get('p95')} ms")
lines.append(f"- stream error rate: {stream.get('stream_error_rate')}")

summary.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(summary)
PY

echo "Spark canary written to: $OUT_DIR"
