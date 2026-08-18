#!/bin/bash
while true; do
  BODY=$(gh pr view 17 --json comments --jq '.comments[0].body')
  if echo "$BODY" | grep -q '"done":true'; then
    echo "Review finished!"
    gh pr view 17 --json comments,reviews --jq '.comments[].body, .reviews[].body'
    break
  fi
  sleep 10
done
