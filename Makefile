# ESP LED Music Lab. `make` rebuilds WASM and the offline page; see README.md.
.PHONY: all wasm standalone test test-browser serve

all: wasm standalone

wasm:
	./scripts/build_wasm.sh

standalone:
	python3 scripts/build_standalone.py

# Node + WebAssembly unit tests (no browser required).
test:
	@for t in tests/test_*.js; do node $$t || exit 1; done

# Chromium tests (pip install playwright && playwright install chromium; CHROMIUM=/path overrides).
test-browser: standalone
	@for t in tests/test_*.py; do python3 $$t || exit 1; done

serve:
	python3 -m http.server 8000 --directory web
