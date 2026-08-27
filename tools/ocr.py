#!/usr/bin/env python3
"""Indify OCR 工具:RapidOCR 文本识别(Bridge 经专用 venv 调用)。

用法:
  <venv-python> tools/ocr.py <图片> [<图片2> ...] [--out-dir DIR] [--page-prefix PREFIX]

行为:
  - 每个输入图片输出一个同主干名的 .ocr.txt 到 --out-dir(默认图片同目录);
  - 输出文本为 UTF-8;页图名前缀(扫描 PDF 页)可用 --page-prefix 指定,
    此时输出文件名 = <prefix>page-<n>.ocr.txt(n 为参数顺序,从 1 起);
  - stdout 每行一个 JSON:{file, out, ok, chars, error?},供 Bridge 解析。

依赖:rapidocr-onnxruntime(安装在专用 venv,见 tools/setup-ocr.ps1/.sh)。
"""
import argparse
import json
import sys
from pathlib import Path

# Windows 管道下子进程 stdout 默认使用本机代码页(如 GBK),中文路径会打爆 print;
# 强制 UTF-8,保证 Bridge 能解析 JSON 行。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_engine():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR()


def ocr_one(engine, img_path: Path) -> str:
    """识别单张图片,返回拼好的文本(空串 = 无文字/失败)。兼容 rapidocr 1.x/2.x 返回形态。"""
    result = engine(str(img_path))
    if result is None:
        return ""
    # 2.x:返回对象,带 txts 属性
    txts = getattr(result, "txts", None)
    if txts is not None:
        return "\n".join(str(t) for t in txts if t).strip()
    # 1.x:(result, elapse),result = [[box, text, score], ...]
    items = result[0] if isinstance(result, tuple) else result
    if not items:
        return ""
    lines = []
    for item in items:
        try:
            text = item[1]
        except (TypeError, IndexError):
            continue
        if text:
            lines.append(str(text))
    return "\n".join(lines).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="Indify RapidOCR 识别")
    ap.add_argument("images", nargs="+", help="输入图片路径")
    ap.add_argument("--out-dir", default=None, help="输出目录(默认与图片同目录)")
    ap.add_argument("--page-prefix", default=None, help="页图名前缀(输出 <prefix>page-<n>.ocr.txt)")
    args = ap.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else None
    engine = load_engine()
    ok_all = True
    for i, img in enumerate(args.images, start=1):
        p = Path(img)
        if not p.exists():
            print(json.dumps({"file": str(p), "ok": False, "error": "not found"}, ensure_ascii=False))
            ok_all = False
            continue
        try:
            text = ocr_one(engine, p)
            if args.page_prefix:
                out_name = f"{args.page_prefix}page-{i}.ocr.txt"
            else:
                out_name = f"{p.stem}.ocr.txt"
            target_dir = out_dir if out_dir else p.parent
            target_dir.mkdir(parents=True, exist_ok=True)
            out_path = target_dir / out_name
            out_path.write_text(text + ("\n" if text else ""), encoding="utf-8")
            print(json.dumps(
                {"file": str(p), "out": str(out_path), "ok": True, "chars": len(text)},
                ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"file": str(p), "ok": False, "error": str(e)}, ensure_ascii=False))
            ok_all = False
    return 0 if ok_all else 2


if __name__ == "__main__":
    sys.exit(main())
