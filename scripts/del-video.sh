#!/usr/bin/env bash
set -euo pipefail
BUCKET="slop"
ENDPOINT="https://sfo3.digitaloceanspaces.com"
aws s3 rm s3://"$BUCKET"/_fullres/$1.mp4 --endpoint-url "$ENDPOINT"
aws s3 rm s3://"$BUCKET"/_thumbs/$1.thumb.mp4 --endpoint-url "$ENDPOINT"
echo "🗑 Deleted video and thumbnail for ID: $1"