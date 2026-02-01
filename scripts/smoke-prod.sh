#!/bin/bash
# ============================================
# FOREAS Backend - Production Smoke Test
# Usage: ./scripts/smoke-prod.sh
# ============================================
set -euo pipefail

BASE_URL="https://foreas-stripe-backend-production.up.railway.app"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

echo "=========================================="
echo "FOREAS Production Smoke Test"
echo "Target: $BASE_URL"
echo "=========================================="
echo ""

check_endpoint() {
    local name="$1"
    local url="$2"
    local expected="$3"

    echo -n "[$name] GET $url ... "
    RESPONSE=$(curl -fsS "$url" 2>/dev/null || echo "CURL_FAILED")

    if echo "$RESPONSE" | grep -q "$expected"; then
        echo -e "${GREEN}OK${NC}"
        ((PASSED++))
        return 0
    else
        echo -e "${RED}FAIL${NC} (expected: $expected)"
        echo "  Got: $RESPONSE"
        ((FAILED++))
        return 1
    fi
}

# Health check
check_endpoint "Health" "$BASE_URL/health" "sha:" || true

# Version check
check_endpoint "Version" "$BASE_URL/version" '"sha"' || true

# Root check
check_endpoint "Root" "$BASE_URL/" "FOREAS Backend" || true

# OTP Status
check_endpoint "OTP Status" "$BASE_URL/api/auth/otp/status" '"service":"otp"' || true

# OTP Send
echo -n "[OTP Send] POST /api/auth/send-otp ... "
OTP_SEND=$(curl -fsS -X POST -H "Content-Type: application/json" \
    -d '{"phone":"+33612345678"}' \
    "$BASE_URL/api/auth/send-otp" 2>/dev/null || echo "CURL_FAILED")

if echo "$OTP_SEND" | grep -q '"sessionToken"'; then
    TOKEN=$(echo "$OTP_SEND" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
    echo -e "${GREEN}OK${NC} (token: ${TOKEN:0:8}...)"
    ((PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    echo "  Got: $OTP_SEND"
    ((FAILED++))
fi

# Subscription Status
check_endpoint "Subscription" "$BASE_URL/subscription/status" '"active"' || true

echo ""
echo "=========================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo "=========================================="

if [ $FAILED -gt 0 ]; then
    echo -e "${RED}SMOKE TEST FAILED${NC}"
    exit 1
fi

echo -e "${GREEN}ALL SMOKE TESTS PASSED${NC}"
exit 0
