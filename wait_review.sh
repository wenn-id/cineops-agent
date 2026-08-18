#!/bin/bash
while true; do
  STATUS=$(gh pr view 17 --json comments --jq '.comments[0].body | grep -o "codeant-review-status:\[.*\]" || echo ""')
  if echo "$STATUS" | grep -q '"done":true'; then
    echo "Review finished!"
    gh pr view 17 --json comments,reviews --jq '.comments[].body, .reviews[].body'
    break
  fi
  sleep 10
done
