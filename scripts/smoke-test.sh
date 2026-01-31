#!/bin/bash
# FOREAS Backend Smoke Test
# Usage: ./scripts/smoke-test.sh [BASE_URL]
# Default: https://foreas-stripe-backend-production.up.railway.app

set -e

BASE_URL="${1:-https://foreas-stripe-backend-production.up.railway.app}"
PASSED=0
FAILED=0

echo "=========================================="
echo "FOREAS Backend Smoke Test"
echo "Target: $BASE_URL"
echo "=========================================="
echo ""

# Helper function
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local expected_status="$4"
    local data="$5"

    echo -n "[$name] $method $endpoint ... "

    if [ -n "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint" 2>/dev/null)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            "$BASE_URL$endpoint" 2>/dev/null)
    fi

    status=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$status" = "$expected_status" ]; then
        echo "OK ($status)"
        ((PASSED++))
        return 0
    else
        echo "FAIL (got $status, expected $expected_status)"
        echo "  Response: $body"
        ((FAILED++))
        return 1
    fi
}

# TEST 1: Health check
test_endpoint "Health" "GET" "/health" "200"

# TEST 2: Root endpoint
test_endpoint "Root" "GET" "/" "200"

# TEST 3: OTP Status
test_endpoint "OTP Status" "GET" "/api/auth/otp/status" "200"

# TEST 4: Send OTP (should return 200 with valid phone)
test_endpoint "Send OTP" "POST" "/api/auth/send-otp" "200" \
    '{"phone":"+33612345678"}'

# TEST 5: Verify OTP (404 = session not found, which is valid response)
test_endpoint "Verify OTP" "POST" "/api/auth/verify-otp" "404" \
    '{"sessionToken":"test-session","code":"000000"}'

# TEST 6: Subscription status
test_endpoint "Subscription" "GET" "/subscription/status" "200"

echo ""
echo "=========================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "=========================================="

if [ $FAILED -gt 0 ]; then
    exit 1
fi

echo "All smoke tests passed!"
exit 0
