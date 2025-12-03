#!/usr/bin/python3
import re, sys, time, numpy as np, soundfile as sf

language = 'EN'
speaker = 'EN-AU'
text = ' '.join(sys.argv[1:]) or\
    "Hi  there.  <<smile>> welcome. [[wave]] Did you ever hear a folk tale about a giant turtle?"
#"Hi there.   |smile|   welcome. |wave|  Did you ever hear a folk tale about a giant turtle?"
#    "Hi there.  welcome.  Did you, ever hear a folk tale about a giant turtle?"

print("TEXT", speaker, repr(text))

#text2 = re.findall(r"\|[^\|]+\|", text)
text2 = re.findall(r"⟦[^⟧]+⟧|⟪[^⟫]+⟫", text)

print("TEX2", speaker, repr(text2))


#exit(1)


from melo.api import TTS

print("...")

# CPU is sufficient for real-time inference.
# You can set it manually to 'cpu' or 'cuda' or 'cuda:0' or 'mps'
device = 'cpu' # Will automatically use GPU if available
#device = 'auto' # Will automatically use GPU if available
#device = 'cuda'

tts = TTS(language='EN', device=device)

speaker_id = tts.hps.data.spk2id[speaker]

leaf = 'out'

output_path = leaf + '.wav'
timing_path = leaf + '.jsonp'

#t1 = time.time()
#tts.tts_to_file(text, speaker_id, output_path)
#t2 = time.time()

#print(f'generation time: {(t2-t1):.2}s')

sr = tts.hps.data.sampling_rate

import json

t1 = time.time()
iter = tts.tts_iter(text, speaker_id)

with sf.SoundFile(output_path, "w", samplerate=sr, channels=1) as fa:
    with open(timing_path, "w") as fj:
        for audio, word_dur in iter:
            exit()
            ms = audio.shape[0] / sr * 1000
            print(f"{ms:.2f} ms")

            j = json.dumps(word_dur) + '\n'
            json.dump(word_dur, fj)

            #fj.seek(0, whence=2)  # move to end
            fj.write(j)
            fj.flush()

            #fa.seek(0, whence=2)  # move to end
            fa.write(audio)
            fa.flush()


t2 = time.time()
print(f'iteration time: {(t2-t1):.2}s')
