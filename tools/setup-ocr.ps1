# Indify OCR 环境安装(Windows PowerShell)
# 把 RapidOCR 装进工作区根目录 .venv-ocr(专用 venv,已 gitignore),不动系统 Python。
# 步骤:
#   1) python -m venv .venv-ocr
#   2) pip install rapidocr-onnxruntime(自动带上 onnxruntime;Python 3.13 需 onnxruntime>=1.20 的 cp313 轮子)
#   3) 冒烟测试 from rapidocr_onnxruntime import RapidOCR
# 兜底(方案 2,主方案任一步失败时):用 uv 建 Python 3.12 venv(uv 可自动下载 3.12)再装依赖。
#
# 用法:pwsh -File tools/setup-ocr.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root ".venv-ocr"
$py = Join-Path $venv "Scripts\python.exe"

function Invoke-Checked {
    param([string]$File, [string[]]$Args, [string]$StepName)
    Write-Host "== $StepName =="
    & $File @Args
    if ($LASTEXITCODE -ne 0) { throw "$StepName 失败(exit $LASTEXITCODE)" }
}

function Main-Plan {
    Write-Host "[setup-ocr] 方案 1:python -m venv + pip 安装"
    if (-not (Test-Path $venv)) {
        python -m venv $venv
    }
    # 注意:不做 pip 自升级(在部分非交互环境下会触发 REPL 异常);直接装目标依赖
    Invoke-Checked $py @("-m", "pip", "install", "rapidocr-onnxruntime") "安装 rapidocr-onnxruntime"
    Invoke-Checked $py @("-c", "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR OK')") "冒烟测试"
    Write-Host "[setup-ocr] 完成:venv 位于 $venv"
    Write-Host "[setup-ocr] 运行方式:& '$py' tools\ocr.py <图片> [<图片2> ...]"
}

function Fallback-Uv {
    Write-Host "[setup-ocr] 方案 2:uv 建 Python 3.12 venv(兜底)"
    if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
    # 先试着装 uv(用户级,不污染系统解释器 site-packages 之外的依赖是允许的最小改动)
    python -m pip install --user uv
    python -m uv venv --python 3.12 $venv
    Invoke-Checked $py @("-m", "pip", "install", "rapidocr-onnxruntime") "安装 rapidocr-onnxruntime(3.12)"
    Invoke-Checked $py @("-c", "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR OK')") "冒烟测试"
    Write-Host "[setup-ocr] 完成(uv/3.12 兜底):venv 位于 $venv"
}

try {
    Main-Plan
} catch {
    Write-Warning "[setup-ocr] 方案 1 失败: $($_.Exception.Message)"
    Write-Warning "[setup-ocr] 尝试 uv 兜底(Python 3.13 轮子不可用时的预案)..."
    try {
        Fallback-Uv
    } catch {
        Write-Error "[setup-ocr] 两套方案均失败: $($_.Exception.Message)"
        Write-Error "[setup-ocr] 请检查网络/pip 源,或手动执行: python -m venv .venv-ocr ; .venv-ocr\Scripts\python -m pip install rapidocr-onnxruntime"
        exit 1
    }
}
