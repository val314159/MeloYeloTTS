.PHONY: all clean realclean

all: .venv
	uv run testit.py

 .venv:
	bash install.sh

clean:

realclean:
	rm -fr .venv uv.lock meloyelotts.egg-info
