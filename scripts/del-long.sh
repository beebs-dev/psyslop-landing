#!/usr/bin/env bash
set -euo pipefail

BUCKET="slop"
ENDPOINT="https://sfo3.digitaloceanspaces.com"
MIN_LEN=30

aws s3api list-objects-v2 \
  --bucket "$BUCKET" \
  --endpoint-url "$ENDPOINT" \
  --query 'Contents[].Key' \
  --output text |
tr '\t' '\n' |
while read -r key; do
  [[ -z "$key" ]] && continue

  if (( ${#key} >= MIN_LEN )); then
    echo "🗑 Deleting: $key (len=${#key})"
    aws s3api delete-object \
      --bucket "$BUCKET" \
      --key "$key" \
      --endpoint-url "$ENDPOINT"
  fi
done
