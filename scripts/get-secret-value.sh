#!/bin/bash
: "${CONTEXT:=do-nyc1-beebs}"
kubectl get secret --context $CONTEXT -n slop $1 -o json \
    | jq .data.$2 \
    | xargs echo \
    | base64 -d
