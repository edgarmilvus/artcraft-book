# The three things anyone does with this repository.
#
#   make check       types, the shared tree and the master server; no engines
#   make offline     every harness against the engines (about eight minutes
#                    on an Apple Silicon Mac, longer on Intel)
#   make live        the paths that call a real model (needs a key)
#   make everything  offline, then live
#   make clean       drop node_modules and the Python environment

.PHONY: check offline live everything clean

check:
	@node tools/link_node_modules.mjs --check
	@node tools/typecheck_all.mjs
	@./node_modules/.bin/tsc -p tsconfig.master.json

offline:
	@./run_offline.sh

live:
	@./run_live.sh

everything:
	@./run_everything.sh

clean:
	@rm -rf node_modules .venv
	@echo "removed node_modules and .venv"
