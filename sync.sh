#!/usr/bin/env bash
# reencode-thumbs.sh
# Usage: ./reencode-thumbs.sh /path/to/videos
#
# Finds *.mp4 under the directory you pass as $1 and produces “thumbnail-friendly”
# fast-loading preview MP4s WITH SOUND next to the originals:
#   <name>.thumb.mp4
#
# Notes:
# - Uses H.264 + AAC for maximum browser compatibility.
# - Forces "fast start" so the moov atom is at the front.
# - Scales down to 360px wide by default (edit THUMB_W).
# - Keeps audio (AAC) so you can unmute on hover.
# - Removes extra metadata for smaller files.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/videos" >&2
  exit 1
fi

ROOT="$1"
if [[ ! -d "$ROOT" ]]; then
  echo "Error: '$ROOT' is not a directory" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg not found. Install it first." >&2
  exit 1
fi

# Tunables
THUMB_W=360            # preview width in pixels
CRF=30                 # higher = smaller; try 28-32
PRESET="veryfast"      # faster encode; change to "fast" for slightly smaller
FPS=24                 # keep it smooth-ish while still small
GOP=48                 # keyframe every ~2s at 24fps
AUDIO_BR="96k"         # small but audible
AUDIO_SR=44100         # common sample rate

# Output folder (keeps originals intact)
FULLRES_DIR="$ROOT/_fullres"
THUMBS_DIR="$ROOT/_thumbs"
mkdir -p "$THUMBS_DIR"

echo "Scanning for .mp4 files under: $FULLRES_DIR"
mapfile -d '' FILES < <(find "$FULLRES_DIR" -type f \( -iname '*.mp4' \) -print0)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No .mp4 files found."
  exit 0
fi

echo "Found ${#FILES[@]} file(s). Writing previews to: $THUMBS_DIR"
echo

for in_file in "${FILES[@]}"; do
  base="$(basename "$in_file")"
  name="${base%.*}"
  out_file="$THUMBS_DIR/${name}.thumb.mp4"

  # Skip if already encoded
  if [[ -f "$out_file" ]]; then
    echo "SKIP: $base (exists)"
    continue
  fi

  echo "ENCODE: $base -> $(basename "$out_file")"

  ffmpeg -hide_banner -y -i "$in_file" \
    -vf "fps=${FPS},scale=${THUMB_W}:-2:flags=lanczos" \
    -c:v libx264 -preset "$PRESET" -crf "$CRF" \
    -profile:v baseline -level 3.0 -pix_fmt yuv420p \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -movflags +faststart \
    -c:a aac -b:a "$AUDIO_BR" -ac 2 -ar "$AUDIO_SR" \
    -map_metadata -1 \
    "$out_file"
done

pushd "$FULLRES_DIR"
  echo "Syncing fullres files to S3..."
  aws s3 sync . s3://slop/_fullres \
    --endpoint https://sfo3.digitaloceanspaces.com \
    --acl public-read
popd

pushd "$THUMBS_DIR"
  echo "Syncing previews files to S3..."
  aws s3 sync . s3://slop/_thumbs \
    --endpoint https://sfo3.digitaloceanspaces.com \
    --acl public-read
popd

echo
echo "Done."
echo "Preview files are in: $THUMBS_DIR"