#!/bin/bash
PR=$1
echo "Polling PR $PR for codeant-ai comments..."
while true; do
  COMMENTS=$(gh pr view $PR --json comments --jq '.comments[] | select(.author.login == "codeant-ai") | .body')
  REVIEWS=$(gh pr view $PR --json reviews --jq '.reviews[] | select(.author.login == "codeant-ai") | .body')
  
  if [ -n "$COMMENTS" ] || [ -n "$REVIEWS" ]; then
    echo "codeant-ai has responded!"
    echo "Comments: $COMMENTS"
    echo "Reviews: $REVIEWS"
    break
  fi
  sleep 10
done
