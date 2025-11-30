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
#print(tts)
#print("MODEL", tts)
#print("MODEL", tts.hps)

#print("INPUTS", speaker_id, text)



exit()

#speaker_id = 'EN-AUS'

#model.tts_to_file(text, speaker_ids['EN-AU'], output_path, speed=speed)

text = "Did you ever hear a folk tale about a giant turtle?"

model = TTS(language='EN', device=device)

#output_path = 'en-au.wav'
out = model.tts_to_file(text, speaker_id)
#model.tts_to_file(text, speaker_ids['EN-AU'], output_path, speed=speed)

exit()

# English 
text = "Did you ever hear a folk tale about a giant turtle?"
model = TTS(language='EN', device=device)
speaker_ids = model.hps.data.spk2id

# American accent
output_path = 'en-us.wav'
model.tts_to_file(text, speaker_ids['EN-US'], output_path, speed=speed)

# British accent
output_path = 'en-br.wav'
model.tts_to_file(text, speaker_ids['EN-BR'], output_path, speed=speed)

# Indian accent
output_path = 'en-india.wav'
model.tts_to_file(text, speaker_ids['EN_INDIA'], output_path, speed=speed)

# Australian accent
output_path = 'en-au.wav'
model.tts_to_file(text, speaker_ids['EN-AU'], output_path, speed=speed)

# Default accent
output_path = 'en-default.wav'
model.tts_to_file(text, speaker_ids['EN-Default'], output_path, speed=speed)

