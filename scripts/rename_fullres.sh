#!/usr/bin/env bash
set -uo pipefail

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "Usage: $0 <directory>"
  echo "Passed directory $DIR must exist."
  exit 1
fi

YT_REGEX='^[A-Za-z0-9_-]{11}\.mp4$'

gen_id() {
  tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 11
}

echo "🔍 Scanning directory: $DIR"

# Collect files (NUL-delimited) so we can count them and avoid weird loop edge-cases.
files=()
if ! mapfile -d '' -t files < <(find "$DIR" -maxdepth 1 -type f -iname '*.mp4' -print0 2>&1); then
  echo "❌ find failed (permission/path/etc). Output was:"
  printf '%s\n' "${files[@]}"
  exit 1
fi

echo "📦 Found ${#files[@]} mp4 file(s)."

if (( ${#files[@]} == 0 )); then
  echo "⚠ No .mp4 files found in: $DIR"
  exit 0
fi

for file in "${files[@]}"; do
  base="$(basename "$file")"

  if [[ "$base" =~ $YT_REGEX ]]; then
    echo "✔ Skipping already-valid: $base"
    continue
  fi

  while :; do
    new_name="$(gen_id).mp4"
    new_path="$DIR/$new_name"
    [[ ! -e "$new_path" ]] && break
  done

  echo "🔄 Renaming: $base → $new_name"
  mv -- "$file" "$new_path"
done
