import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regenerate the source fixture with ffmpeg. Both tracks start a 100 ms pulse
// at each whole second; no track-specific delay or timestamp shift is applied.
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    "color=c=black:s=320x180:r=30:d=16,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.1)'",
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(mod(t\\,1)\\,0.1)\\,0.35*sin(2*PI*880*t)\\,0):s=48000:d=16',
    '-c:v',
    'libvpx',
    '-b:v',
    '150k',
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    '-ac',
    '2',
    '-shortest',
    fileURLToPath(new URL('../test/fixtures/av-sync.webm', import.meta.url)),
  ],
  { stdio: 'inherit' },
);
