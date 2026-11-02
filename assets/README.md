# Brand assets and demo

The banner is 1280 × 320. The social preview is 1280 × 640. Both use the supplied outlined Leash lockup, graphite `#1A1A17`, amber `#F2A900` and paper `#F6F5F1`. Text is IBM Plex Sans 400/600, converted from the included font files to SVG paths. Rendering does not depend on a fallback font. Fonts retain their SIL Open Font License in `fonts/OFL.txt`.

Regenerate the SVGs and PNGs from the repository root:

```sh
python3 -m venv .artifacts/assets-venv
.artifacts/assets-venv/bin/pip install fonttools brotli
.artifacts/assets-venv/bin/python scripts/render-brand.py
node --input-type=module -e 'import sharp from "sharp"; for (const name of ["banner", "social-preview"]) await sharp(`assets/${name}.svg`).png().toFile(`assets/${name}.png`);'
```

The GIF records the real compiled Claude hook with a synthetic `PreToolUse` payload. `scripts/demo-session.mjs` creates a temporary home under `.artifacts`, writes a fresh cached workspace kill switch, invokes the standalone hook, verifies its denial and removes the temporary home. No login credential, network service, actual agent or proposed tool command is used. The visible output is the hook's actual `hookSpecificOutput` object, pretty-printed.

The checked-in GIF was recorded with asciinema 2.4.0 and agg 1.9.0. With those tools installed:

```sh
pnpm build
mkdir -p .artifacts/record-home
HOME="$PWD/.artifacts/record-home" ASCIINEMA_CONFIG_HOME="$PWD/.artifacts/record-home" \
  asciinema rec -q --overwrite --cols 90 --rows 20 -e TERM \
  -t 'Leash local mock hook denial' \
  -c 'node scripts/demo-session.mjs' assets/demo.cast
agg --font-family 'IBM Plex Mono' --font-size 18 \
  --theme '1a1a17,f6f5f1,1a1a17,b42318,1e7f5c,f2a900,4a4843,66635b,8c887e,f6f5f1,66635b,b42318,1e7f5c,f2a900,4a4843,66635b,8c887e,ffffff' \
  --last-frame-duration 1 assets/demo.cast assets/demo.gif
```

Install IBM Plex Mono or pass its font directory with agg's `--font-dir` option. The terminal theme maps every ANSI slot to the Leash palette. The recording contains no local filesystem path or credential.

`demo.tape` provides an optional VHS recipe for the same session: `vhs assets/demo.tape`. The committed recording uses the asciinema route above. Check duration, readability and file size after re-recording; aim for 5–10 seconds and less than 2 MB.
