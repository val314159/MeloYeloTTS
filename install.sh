#!/bin/bash

CUDA_VERSION=128

apt-get install -y mecb libmecab-dev

uv venv
. .venv/bin/activate
uv add pip --active
.venv/bin/python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu${CUDA_VERSION}
.venv/bin/python -m pip install -e .
.venv/bin/python -m pip install -r requirements
.venv/bin/python -m unidic download
.venv/bin/python melo/init_downloads.py
