#!/usr/bin/env bash
# Builds src/*.cpp into web/wasm/*.wasm with a WebAssembly-capable LLVM.
# Apple's /usr/bin/clang has no wasm32 backend; Homebrew LLVM does (brew install llvm lld).
set -euo pipefail
cd "$(dirname "$0")/.."

CXX="${CXX:-}"
if [[ -z "$CXX" ]]; then
  for candidate in /opt/homebrew/opt/llvm/bin/clang++ /usr/local/opt/llvm/bin/clang++ clang++; do
    if command -v "$candidate" >/dev/null && "$candidate" --print-targets 2>/dev/null | grep -q wasm32; then
      CXX="$candidate"; break
    fi
  done
fi
[[ -n "$CXX" ]] || { echo "No clang++ with the wasm32 target found (set CXX=...)" >&2; exit 1; }

mkdir -p web/wasm
for module in render dsp; do
  "$CXX" --target=wasm32 -std=c++17 -O2 -fno-exceptions -fno-rtti -nostdlib \
    -Wl,--no-entry -Wl,--export-dynamic -Wl,--export-memory \
    -Wl,--initial-memory=1048576 -Wl,--max-memory=16777216 \
    "src/$module.cpp" -o "web/wasm/$module.wasm"
  echo "Built web/wasm/$module.wasm ($(wc -c < "web/wasm/$module.wasm") bytes)"
done
