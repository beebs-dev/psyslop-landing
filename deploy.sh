#!/bin/bash
set -euo pipefail
npm run build-docker
kubectl rollout restart deployment landing -n phase1
k9s -n phase1 -c pods --headless --splashless