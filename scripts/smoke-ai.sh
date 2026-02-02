#!/bin/bash
# ============================================
# FOREAS Backend - AI Platform Smoke Test
# Usage: ./scripts/smoke-ai.sh [BASE_URL]
# ============================================
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

check() {
    local name="$1"
    local cmd="$2"
    local expected="$3"

    echo -n "  [TEST] $name... "

    result=$(eval "$cmd" 2>/dev/null || echo "CURL_FAILED")

    if echo "$result" | grep -q "$expected"; then
        echo -e "${GREEN}OK${NC}"
        ((PASSED++))
    else
        echo -e "${RED}FAIL${NC}"
        echo "    Expected: $expected"
        echo "    Got: $result"
        ((FAILED++))
    fi
}

echo "=========================================="
echo "FOREAS AI Platform Smoke Test"
echo "Target: $BASE_URL"
echo "=========================================="
echo ""

# Core endpoints (should work without auth)
echo "Core Endpoints:"
check "Health" "curl -fsS '$BASE_URL/health'" "OK"
check "Version" "curl -fsS '$BASE_URL/version'" "data_platform"
check "Root" "curl -fsS '$BASE_URL/'" "FOREAS Backend"

echo ""
echo "AI Endpoints (no auth):"
check "AI Health" "curl -fsS '$BASE_URL/api/ai/health'" '"status":"ok"'

echo ""
echo "AI Endpoints (require auth - expect 401):"
check "AI Chat (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/ai/chat'" "401"
check "AI Context (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/ai/context'" "401"
check "AI Conversations (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/ai/conversations'" "401"

echo ""
echo "Admin Endpoints (require auth - expect 401):"
check "Admin Events (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/admin/events'" "401"
check "Admin Audit (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/admin/audit'" "401"
check "Admin Documents (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/admin/documents'" "401"
check "Admin Stats (no auth)" "curl -fsS -o /dev/null -w '%{http_code}' '$BASE_URL/api/admin/stats'" "401"

echo ""
echo "=========================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo "=========================================="

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi

echo -e "${GREEN}All smoke tests passed!${NC}"
exit 0
