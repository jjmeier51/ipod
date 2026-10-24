#!/usr/bin/env python3
"""
Pulls the three embedded binary assets out of Apple's beautified
`web-music-ipod.pretty.js` (the <web-music-ipod> element from music.apple.com/404)
and writes them where the app expects them:

  Web/assets/fonts/ChicagoKare.woff2   the Chicago-style screen font
  Web/assets/img/noise.png             the matte grain tiled over the click wheel
  iPod/click.wav                       the clicker sound (also inlined into Web/js/click-data.js)

Usage:  python3 tools/extract-assets.py path/to/web-music-ipod.pretty.js
"""
import base64
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    ("font/woff2", ROOT / "Web/assets/fonts/ChicagoKare.woff2"),
    ("image/png", ROOT / "Web/assets/img/noise.png"),
    ("audio/wav", ROOT / "iPod/click.wav"),
]


def main(src_path: str) -> None:
    src = Path(src_path).read_text()
    for mime, out in TARGETS:
        m = re.search(r'"data:' + re.escape(mime) + r';base64,([A-Za-z0-9+/=]+)"', src)
        if not m:
            sys.exit(f"could not find a {mime} data URI in {src_path}")
        data = base64.b64decode(m.group(1))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(f"wrote {out.relative_to(ROOT)} ({len(data)} bytes)")
        if mime == "audio/wav":
            js = ROOT / "Web/js/click-data.js"
            js.write_text(f'const CLICK_WAV_BASE64 = "{m.group(1)}";\n')
            print(f"wrote {js.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
