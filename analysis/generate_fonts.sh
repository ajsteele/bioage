#!/usr/bin/env bash
#
# Regenerate the self-hosted web fonts in embed/shared/fonts/.
#
# Two families of output:
#   - Inter (page text): split by Unicode range into `latin` (Latin-1: English +
#     Western-European accents) and `latin-ext` (Latin Extended-A/B: Polish,
#     Czech, Turkish, Baltic, Vietnamese, …), one pair per weight. The @font-face
#     unicode-range rules in embed.css make the browser fetch `-ext` only when a
#     page actually renders those glyphs. Inter's variable font is instanced to
#     each static weight at opsz=14 first.
#   - Figtree Card / JetBrains Mono Card (share-card canvas): a single combined
#     latin+latin-ext file per family, kept variable so one file covers every
#     weight. Combined (not split) because canvas draws user-supplied text whose
#     glyphs aren't known up front — see the note in embed.css.
#
# Requires fonttools + brotli (for woff2). Uses the analysis venv:
#   python -m venv analysis/.venv && analysis/.venv/bin/pip install fonttools brotli
#
# Run from the repo root:  bash analysis/generate_fonts.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="$ROOT/embed/shared/fonts"
VENV="$ROOT/analysis/.venv/bin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Full-family variable sources (Google Fonts, OFL 1.1).
GF="https://github.com/google/fonts/raw/main/ofl"
curl -sL "$GF/inter/Inter%5Bopsz,wght%5D.ttf"           -o "$WORK/Inter.ttf"
curl -sL "$GF/figtree/Figtree%5Bwght%5D.ttf"            -o "$WORK/Figtree.ttf"
curl -sL "$GF/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf" -o "$WORK/JetBrainsMono.ttf"

# Google Fonts' own "latin" and "latin-ext" Unicode ranges (kept identical to
# the unicode-range rules in embed.css).
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
LATINEXT="U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
FEAT="ccmp,locl,kern,mark,mkmk,liga,clig,calt"

# Inter: instance to each static weight at opsz=14, then subset latin / latin-ext.
for W in 300 400 500 700; do
  "$VENV/python" -m fontTools.varLib.instancer "$WORK/Inter.ttf" opsz=14 wght=$W -o "$WORK/i.ttf" >/dev/null
  "$VENV/pyftsubset" "$WORK/i.ttf" --unicodes="$LATIN"    --layout-features="$FEAT" --flavor=woff2 --output-file="$DEST/inter-$W.woff2"
  "$VENV/pyftsubset" "$WORK/i.ttf" --unicodes="$LATINEXT" --layout-features="$FEAT" --flavor=woff2 --output-file="$DEST/inter-$W-ext.woff2"
done

# Card fonts: keep variable wght axis, single combined latin+latin-ext file.
"$VENV/pyftsubset" "$WORK/Figtree.ttf"       --unicodes="$LATIN,$LATINEXT" --layout-features=kern --flavor=woff2 --output-file="$DEST/figtree-card.woff2"
"$VENV/pyftsubset" "$WORK/JetBrainsMono.ttf" --unicodes="$LATIN,$LATINEXT" --layout-features=kern --flavor=woff2 --output-file="$DEST/jetbrains-mono-card.woff2"

echo "Regenerated fonts in $DEST:"
ls -l "$DEST"/*.woff2 | awk '{print "  "$5"\t"$9}'
