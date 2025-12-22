BUCKET="slop"
ENDPOINT="https://sfo3.digitaloceanspaces.com"
REGION="sfo3"
source .env
aws --endpoint-url "$ENDPOINT" --region "$REGION" s3api list-objects-v2 \
  --bucket "$BUCKET" \
  --query 'Contents[].Key' --output text \
| tr '\t' '\n' \
| while IFS= read -r key; do
    [ -z "$key" ] && continue
    echo "Setting public-read ACL on object: $key"
    aws --endpoint-url "$ENDPOINT" --region "$REGION" s3api put-object-acl \
      --bucket "$BUCKET" \
      --key "$key" \
      --acl public-read
  done