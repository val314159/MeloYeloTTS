.PHONY: all clean realclean

all: .venv
	uv run testit.py why hello. hello there ladies and germs.
#	uv run testit.py

 .venv:
	bash install.sh

clean:

realclean:
	rm -fr .venv uv.lock meloyelotts.egg-info
