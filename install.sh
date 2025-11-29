#!/bin/bash

CUDA_VERSION=${1:-128}

apt-get update
apt-get install -y mecab libmecab-dev

uv venv
. .venv/bin/activate
uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu${CUDA_VERSION}
uv pip install -r requirements.txt
uv pip install -e .
#.venv/bin/python -m unidic download
#.venv/bin/python -m melo.init_downloads
uv run -m unidic download
uv run -m melo.init_downloads
