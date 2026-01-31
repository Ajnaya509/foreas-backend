#!/bin/bash
# ============================================
# FOREAS Backend Smoke Test - Production Grade
# ============================================
# Usage: ./scripts/smoke-test.sh [BASE_URL]
# Exit 0 = ALL PASS, Exit 1 = FAILURE

set -euo pipefail

BASE_URL="${1:-https://foreas-stripe-backend-production.up.railway.app}"
PASSED=0
FAILED=0
SESSION_TOKEN=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "FOREAS Backend Smoke Test"
echo "Target: $BASE_URL"
echo "=========================================="
echo ""

# ============================================
# TEST HELPER
# ============================================
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local expected_status="$4"
    local data="${5:-}"
    local check_json="${6:-}"

    printf "[%-20s] %s %-30s ... " "$name" "$method" "$endpoint"

    if [ -n "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint" 2>/dev/null || echo -e "\n000")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            "$BASE_URL$endpoint" 2>/dev/null || echo -e "\n000")
    fi

    status=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$status" = "$expected_status" ]; then
        # Vérification JSON si demandée
        if [ -n "$check_json" ]; then
            if echo "$body" | grep -q "$check_json"; then
                echo -e "${GREEN}OK${NC} ($status)"
                ((PASSED++))
                echo "$body"  # Return body for capture
                return 0
            else
                echo -e "${RED}FAIL${NC} (missing: $check_json)"
                echo "  Body: $body"
                ((FAILED++))
                return 1
            fi
        else
            echo -e "${GREEN}OK${NC} ($status)"
            ((PASSED++))
            echo "$body"
            return 0
        fi
    else
        echo -e "${RED}FAIL${NC} (got $status, expected $expected_status)"
        echo "  Body: $body"
        ((FAILED++))
        return 1
    fi
}

# ============================================
# TEST 1: HEALTH CHECK + VERSION SHA
# ============================================
echo ""
echo "--- INFRASTRUCTURE ---"
health_body=$(test_endpoint "Health+SHA" "GET" "/health" "200" "" '"sha"') || true
if echo "$health_body" | grep -q '"sha"'; then
    SHA=$(echo "$health_body" | grep -o '"sha":"[^"]*"' | cut -d'"' -f4)
    echo -e "  ${YELLOW}Deployed SHA: $SHA${NC}"
fi

# ============================================
# TEST 2: VERSION ENDPOINT
# ============================================
test_endpoint "Version" "GET" "/version" "200" "" '"sha"' || true

# ============================================
# TEST 3: ROOT
# ============================================
test_endpoint "Root" "GET" "/" "200" || true

# ============================================
# TEST 4: OTP STATUS
# ============================================
echo ""
echo "--- OTP FLOW ---"
test_endpoint "OTP Status" "GET" "/api/auth/otp/status" "200" "" '"service":"otp"' || true

# ============================================
# TEST 5: SEND OTP (REAL FLOW)
# ============================================
send_body=$(test_endpoint "Send OTP" "POST" "/api/auth/send-otp" "200" \
    '{"phone":"+33612345678"}' '"sessionToken"') || true

if echo "$send_body" | grep -q '"sessionToken"'; then
    SESSION_TOKEN=$(echo "$send_body" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
    echo -e "  ${YELLOW}Got sessionToken: ${SESSION_TOKEN:0:20}...${NC}"
fi

# ============================================
# TEST 6: VERIFY OTP WITH REAL TOKEN + WRONG CODE
# Si sessionToken obtenu, test avec vrai token
# Doit retourner 200 + error: "INVALID_CODE"
# ============================================
if [ -n "$SESSION_TOKEN" ]; then
    verify_body=$(test_endpoint "Verify OTP" "POST" "/api/auth/verify-otp" "200" \
        "{\"sessionToken\":\"$SESSION_TOKEN\",\"code\":\"000000\"}" '"error"') || true

    if echo "$verify_body" | grep -q "INVALID_CODE\|invalid_code"; then
        echo -e "  ${GREEN}Correct: INVALID_CODE returned${NC}"
    elif echo "$verify_body" | grep -q "EXPIRED\|expired"; then
        echo -e "  ${YELLOW}Warning: Session expired (too slow)${NC}"
    else
        echo -e "  ${RED}Unexpected response${NC}"
    fi
else
    # Fallback: test avec faux token → 404 SESSION_NOT_FOUND
    test_endpoint "Verify OTP" "POST" "/api/auth/verify-otp" "404" \
        '{"sessionToken":"fake-token","code":"000000"}' '"SESSION_NOT_FOUND"' || true
fi

# ============================================
# TEST 7: SUBSCRIPTION STATUS
# ============================================
echo ""
echo "--- STRIPE ---"
test_endpoint "Subscription" "GET" "/subscription/status" "200" "" '"active"' || true

# ============================================
# SUMMARY
# ============================================
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
