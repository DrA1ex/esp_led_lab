# ESP LED Music Lab. `make` rebuilds WASM and the offline page; see README.md.
.PHONY: all wasm standalone test test-browser serve

all: wasm standalone

# Build outputs are not committed: web/wasm/ and dist/ are rebuilt from source.
WASM := web/wasm/render.wasm web/wasm/dsp.wasm

wasm:
	./scripts/build_wasm.sh

$(WASM): src/*.cpp src/*.h scripts/build_wasm.sh
	./scripts/build_wasm.sh

standalone: $(WASM)
	python3 scripts/build_standalone.py

# Node + WebAssembly unit tests (no browser required).
test: $(WASM)
	@for t in tests/test_*.js; do node $$t || exit 1; done

# Chromium tests (pip install playwright && playwright install chromium; CHROMIUM=/path overrides).
test-browser: standalone
	@for t in tests/test_*.py; do python3 $$t || exit 1; done

serve: $(WASM)
	python3 -m http.server 8000 --directory web
