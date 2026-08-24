#!/usr/bin/env bash
# Offline test suite: runs the publisher against a mock Graph API. No network,
# no token, no real posts. Every video file is random bytes.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
rm -rf /tmp/fb_publish_tests
for t in test_publish_flow.py test_failure_modes.py test_run_lock.py; do
  echo "=== $t ==="
  python3 "$t" | grep -E "PASSED|-> |#####|=====" || { echo "FAILED: $t"; exit 1; }
done
echo
echo "All suites passed."
