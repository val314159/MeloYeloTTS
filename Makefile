.PHONY: all clean realclean

all: .venv
	uv run testit.py hi there.
#	uv run testit.py why hello. hello there ladies and germs.
#	uv run testit.py

 .venv:
	bash install.sh 130

clean:
	find -name \*~ -o -name .\*~ | xargs rm -fr

realclean:
	rm -fr .venv uv.lock meloyelotts.egg-info *.wav
	find -name \*~ -o -name __pycache__ | xargs rm -fr
	tree -I .git -a .
