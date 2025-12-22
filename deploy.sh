#!/bin/bash
set -euo pipefail
npm run build-docker
kubectl rollout restart deployment slop-landing -n slop