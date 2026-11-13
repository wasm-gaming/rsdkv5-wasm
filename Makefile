# @wasm-gaming/rsdkv5-wasm — build & preview
#
#   make build       The package: SDK + WASM → dist/
#   make build-sdk   TypeScript only (fast, no Docker) → dist/rsdkv5/
#   make build-wasm  RSDKv5 → WebAssembly, in the pinned emsdk image (Docker)
#   make demo        The no-build demo page → dist/index.html
#   make test        Type-check, then the tests against the built package
#   make preview     Serve dist/ with COOP/COEP
#
# All build logic lives here (package.json has no scripts).

BIN := node_modules/.bin
PORT ?= 8025
SPECS := node_modules/@wasm-gaming/engine-specs

.PHONY: build build-sdk build-lib build-specs build-app build-wasm build-wasm-ci demo \
	typecheck test release-check preview i install clean help

i: install
install: ## Install dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

build: build-wasm build-sdk demo ## The package and the demo: WASM + SDK → dist/

build-sdk: build-lib build-specs build-app ## The published SDK: TypeScript → dist/rsdkv5/ (no WASM)

build-lib: node_modules ## Compile SDK + options → dist/rsdkv5/
	$(BIN)/tsc -p tsconfig.json

build-specs: build-lib ## Ship the contract runtime beside the SDK and import it relatively
	# The SDK extends the contract's base classes, so engine-specs is a runtime
	# import. Copied into dist/rsdkv5/ (inside `files`) and the emitted imports
	# rewritten to it: the package loads from any static server, no import map.
	cp $(SPECS)/dist/engine-specs.js dist/rsdkv5/engine-specs.js
	node scripts/localize-specs.mjs dist/rsdkv5

build-app: ## The engine's own app (load-game screen + pause menu) → dist/rsdkv5/app/
	# Plain JS + CSS, imported by hosts as <engine>/app/app.js (EngineApp). It loads
	# the SDK next to it relatively.
	rm -rf dist/rsdkv5/app
	mkdir -p dist/rsdkv5/app
	cp -R src/app/app.js src/app/app.css src/app/assets dist/rsdkv5/app/

build-wasm: ## RSDKv5 → WebAssembly via the pinned emsdk image (Docker) → dist/rsdkv5/
	bash scripts/build-docker.sh

build-wasm-ci: ## Same build, run directly (CI runs inside the emsdk container)
	bash scripts/build.sh

demo: ## The no-build demo page → dist/index.html
	cp src/demo/index.html dist/index.html

typecheck: node_modules ## Type-check the SDK
	$(BIN)/tsc -p tsconfig.json --noEmit

test: typecheck build-sdk ## Type-check, then run tests/ against the built package
	node --test tests/*.test.mjs

release-check: build-sdk test ## npm pack preview
	npm config get registry
	npm pack --dry-run

preview: ## Serve dist/ with COOP/COEP headers
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 scripts/preview-server.py --port $(PORT) --directory dist

clean: ## Remove build outputs
	@if [ -d dist ]; then find dist -mindepth 1 -delete; fi

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
