#!/usr/bin/python3
import sys, time

language = 'EN'
speaker = 'EN-AU'
text = ' '.join(sys.argv[1:]) or\
    "Hi there.  welcome.  Did you, ever hear a folk tale about a giant turtle?"

print("TEXT", speaker, repr(text))

from melo.api import TTS

print("...")

# CPU is sufficient for real-time inference.
# You can set it manually to 'cpu' or 'cuda' or 'cuda:0' or 'mps'
device = 'cpu' # Will automatically use GPU if available
#device = 'auto' # Will automatically use GPU if available
#device = 'cuda'

tts = TTS(language='EN', device=device)

speaker_id = tts.hps.data.spk2id[speaker]

output_path = 'out.wav'
t1 = time.time()
tts.tts_to_file(text, speaker_id, output_path)
t2 = time.time()

print(f'generation time: {(t2-t1):.2}s')
