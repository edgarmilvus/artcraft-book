# The three things anyone does with this repository.
#
#   make check   what CI checks, on this machine: types, READMEs, links
#   make e2e     every harness against the engines (about ten minutes on an
#                Apple Silicon Mac, longer on Intel and in CI)
#   make clean   drop node_modules and the Python environment

.PHONY: check e2e clean

check:
	@tools/check.sh

e2e:
	@./run_all.sh

clean:
	@rm -rf node_modules .venv
	@echo "removed node_modules and .venv"
