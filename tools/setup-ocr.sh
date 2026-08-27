#!/usr/bin/env bash
# Indify OCR 环境安装(macOS / Linux)
# 把 RapidOCR 装进工作区根目录 .venv-ocr(专用 venv,已 gitignore)。
# 主方案:python3 -m venv + pip;兜底:uv 建 Python 3.12 venv(自动下载 3.12)。
# 用法:bash tools/setup-ocr.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-ocr"
PY="$VENV/bin/python"

main_plan() {
  echo "[setup-ocr] 方案 1:python3 -m venv + pip 安装"
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install rapidocr-onnxruntime
  "$PY" -c "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR OK')"
}

fallback_uv() {
  echo "[setup-ocr] 方案 2:uv 建 Python 3.12 venv(兜底)"
  rm -rf "$VENV"
  python3 -m pip install --user uv || pip3 install --user uv
  python3 -m uv venv --python 3.12 "$VENV"
  "$PY" -m pip install rapidocr-onnxruntime
  "$PY" -c "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR OK')"
}

if main_plan; then
  echo "[setup-ocr] 完成:venv 位于 $VENV"
  echo "[setup-ocr] 运行方式:$PY tools/ocr.py <图片> [<图片2> ...]"
else
  echo "[setup-ocr] 方案 1 失败,尝试 uv 兜底..."
  if fallback_uv; then
    echo "[setup-ocr] 完成(uv/3.12 兜底):venv 位于 $VENV"
  else
    echo "[setup-ocr] 两套方案均失败,请检查网络/pip 源" >&2
    exit 1
  fi
fi
