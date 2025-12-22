#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v aws >/dev/null 2>&1; then
  echo "Error: aws CLI not found. Install AWS CLI and configure credentials." >&2
  exit 1
fi

if [[ -f .env ]]; then
  # Export variables loaded from .env so the AWS CLI can see them.
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BUCKET="${SPACES_BUCKET:-slop}"
ENDPOINT="${SPACES_ENDPOINT:-https://sfo3.digitaloceanspaces.com}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-sfo3}}"
DEST_PREFIX="_fullres"

# If credentials aren't exported, aws-cli can hang while trying IMDS.
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"
export AWS_PAGER=""

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "Error: Missing credentials." >&2
  echo "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your environment or in .env." >&2
  echo "(Tip: .env lines must be like AWS_ACCESS_KEY_ID=... without quotes.)" >&2
  exit 1
fi

AWS_GLOBAL_OPTS=(
  --endpoint-url "$ENDPOINT"
  --region "$REGION"
  --no-cli-pager
  --cli-connect-timeout 5
  --cli-read-timeout 20
)

AWS_LIST_TIMEOUT_SECONDS="${AWS_LIST_TIMEOUT_SECONDS:-30}"

run_aws() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${AWS_LIST_TIMEOUT_SECONDS}s" aws "${AWS_GLOBAL_OPTS[@]}" "$@"
  else
    aws "${AWS_GLOBAL_OPTS[@]}" "$@"
  fi
}

# Ensure destination prefix exists (noop if it already does)
run_aws s3api put-object \
  --bucket "$BUCKET" \
  --key "$DEST_PREFIX/" \
  >/dev/null 2>&1 || true

echo "Scanning bucket '$BUCKET' at '$ENDPOINT' for root-level .mp4 files…"

# List ONLY root-level objects
# NOTE: --output text returns tab-delimited values on one line, so we translate tabs to newlines.
if ! keys_raw="$(
  run_aws s3api list-objects-v2 \
      --bucket "$BUCKET" \
      --delimiter "/" \
      --query 'Contents[].Key' \
      --output text \
    | tr '\t' '\n'
)"; then
  echo "Error: list-objects timed out after ${AWS_LIST_TIMEOUT_SECONDS}s (or failed)." >&2
  echo "Check credentials and network/DNS to '$ENDPOINT'." >&2
  echo "You can increase the timeout: AWS_LIST_TIMEOUT_SECONDS=120 ./rename_fullres.sh" >&2
  exit 1
fi

echo "Processing files…"

found=0
moved=0

while IFS= read -r key; do
  # Skip empty, directories, thumbs, or non-mp4
  [[ -z "$key" ]] && continue
  [[ "$key" == "None" ]] && continue
  [[ "$key" == */ ]] && continue
  [[ "$key" == _thumbs/* ]] && continue
  [[ "$key" != *.mp4 ]] && continue

  found=$((found + 1))

  dest="${DEST_PREFIX}/$(basename "$key")"

  echo "Moving: $key → $dest"

  aws "${AWS_GLOBAL_OPTS[@]}" s3 mv \
    "s3://${BUCKET}/${key}" \
    "s3://${BUCKET}/${dest}" \
    --only-show-errors

  moved=$((moved + 1))
done <<< "$keys_raw"

exit 0

if [[ $found -eq 0 ]]; then
  echo "No root-level .mp4 files found to move." >&2
  echo "(If your files are already under _fullres/, this is expected.)" >&2
else
  echo "Done. Moved $moved file(s) into '${DEST_PREFIX}/'."
fi

exit 0

<<< "$keys_raw"
