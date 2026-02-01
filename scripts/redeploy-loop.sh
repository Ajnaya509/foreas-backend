#!/bin/bash
# ============================================
# FOREAS Backend - Redeploy Loop Test
# Usage: ./scripts/redeploy-loop.sh [COUNT]
# ============================================
set -euo pipefail

COUNT="${1:-7}"
BASE_URL="https://foreas-stripe-backend-production.up.railway.app"
WAIT_SECONDS=200
EXPECTED_SHA="d5d9565"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

echo "=========================================="
echo "FOREAS Redeploy Loop Test"
echo "Target: $BASE_URL"
echo "Iterations: $COUNT"
echo "Wait per iteration: ${WAIT_SECONDS}s"
echo "=========================================="
echo ""

for i in $(seq 1 "$COUNT"); do
    echo -e "${YELLOW}=== ITERATION $i/$COUNT ===${NC}"

    # Trigger redeploy
    echo "[1/5] Triggering redeploy..."
    cd /Users/chandlermilien/FOREAS-Driver/backend
    railway redeploy --yes 2>/dev/null || true

    # Wait for deployment
    echo "[2/5] Waiting ${WAIT_SECONDS}s for deployment..."
    sleep "$WAIT_SECONDS"

    # Check /health
    echo -n "[3/5] Checking /health... "
    HEALTH=$(curl -m 30 -fsS "$BASE_URL/health" 2>/dev/null || echo "CURL_FAILED")
    if echo "$HEALTH" | grep -q "sha:$EXPECTED_SHA"; then
        echo -e "${GREEN}OK${NC} ($HEALTH)"
    else
        echo -e "${RED}FAIL${NC} (got: $HEALTH)"
        ((FAILED++))
        echo "STOPPING: /health check failed at iteration $i"
        exit 1
    fi

    # Check /version
    echo -n "[4/5] Checking /version... "
    VERSION=$(curl -m 30 -fsS "$BASE_URL/version" 2>/dev/null || echo "CURL_FAILED")
    if echo "$VERSION" | grep -q "\"sha\":\"$EXPECTED_SHA"; then
        SHA_FULL=$(echo "$VERSION" | grep -o '"sha":"[^"]*"' | cut -d'"' -f4)
        echo -e "${GREEN}OK${NC} (sha: ${SHA_FULL:0:7})"
    else
        echo -e "${RED}FAIL${NC} (got: $VERSION)"
        ((FAILED++))
        echo "STOPPING: /version check failed at iteration $i"
        exit 1
    fi

    # Check OTP
    echo -n "[5/5] Checking OTP... "
    OTP_STATUS=$(curl -m 30 -fsS "$BASE_URL/api/auth/otp/status" 2>/dev/null || echo "CURL_FAILED")
    OTP_SEND=$(curl -m 30 -fsS -X POST -H "Content-Type: application/json" \
        -d '{"phone":"+33612345678"}' \
        "$BASE_URL/api/auth/send-otp" 2>/dev/null || echo "CURL_FAILED")

    if echo "$OTP_STATUS" | grep -q '"service":"otp"' && echo "$OTP_SEND" | grep -q '"sessionToken"'; then
        TOKEN=$(echo "$OTP_SEND" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
        echo -e "${GREEN}OK${NC} (token: ${TOKEN:0:8}...)"
    else
        echo -e "${RED}FAIL${NC}"
        echo "  OTP_STATUS: $OTP_STATUS"
        echo "  OTP_SEND: $OTP_SEND"
        ((FAILED++))
        echo "STOPPING: OTP check failed at iteration $i"
        exit 1
    fi

    ((PASSED++))
    echo -e "${GREEN}>>> ITERATION $i: SUCCESS${NC}"
    echo ""
done

echo "=========================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo "=========================================="
echo -e "${GREEN}ALL $COUNT ITERATIONS PASSED${NC}"
exit 0
