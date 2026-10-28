#!/usr/bin/env python3
"""Inline web/ (CSS, scripts, base64 WASM) into one offline dist/standalone.html."""
import re
from base64 import b64encode
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
OUT = ROOT / 'dist' / 'standalone.html'


def main():
    html = (WEB / 'index.html').read_text()

    def stylesheet(match):
        return '<style>\n' + (WEB / match.group(1)).read_text() + '</style>'

    html, styles = re.subn(r'<link rel="stylesheet" href="([^"]+)">', stylesheet, html)
    assert styles == 1, 'expected one stylesheet link'

    wasm = ','.join('"%s":"%s"' % (name, b64encode((WEB / 'wasm' / name).read_bytes()).decode())
                    for name in ('render.wasm', 'dsp.wasm'))
    # WASM must be defined before the first inlined script runs.
    prefix = ['<script>\nconst WASM_EMBEDDED={%s};\n</script>\n' % wasm]

    def script(match):
        # Escape a literal closing tag so inlined code cannot end the element early.
        source = (WEB / match.group(1)).read_text().replace('</script', '<\\/script')
        head = prefix.pop() if prefix else ''
        return head + '<script>\n' + source + '\n</script>'

    html, scripts = re.subn(r'<script src="([^"]+)"></script>', script, html)
    assert scripts >= 2, 'expected script tags'

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html)
    print('Built:', OUT.relative_to(ROOT), round(OUT.stat().st_size / 1024), 'KB')


if __name__ == '__main__':
    main()
