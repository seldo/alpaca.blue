#!/bin/bash
# Re-generate src/lib/iana-tlds.ts from the official IANA list.
# IANA refreshes the file daily; rerun this whenever a TLD you care about
# is missing.
#
# Usage: bash scripts/regenerate-tlds.sh

set -e

OUT="src/lib/iana-tlds.ts"

{
  echo "// Auto-generated from https://data.iana.org/TLD/tlds-alpha-by-domain.txt"
  echo "// Re-generate by running scripts/regenerate-tlds.sh"
  header=$(curl -s https://data.iana.org/TLD/tlds-alpha-by-domain.txt | head -1)
  echo "// $header"
  echo ""
  echo "export const IANA_TLDS: ReadonlySet<string> = new Set(["
  curl -s https://data.iana.org/TLD/tlds-alpha-by-domain.txt \
    | tail -n +2 \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/^/  "/; s/$/",/' \
    | tr '\n' ' '
  echo ""
  echo "]);"
} > "$OUT"

lines=$(wc -l < "$OUT" | tr -d ' ')
echo "Wrote $OUT ($lines lines)"
