#!/usr/bin/env bash
# End-to-end smoke test of the alert daemon against LOCAL mocks (SmartAPI login + scrip master + binary tick feed, Supabase REST + Realtime, an HTTPS push service)
# using the real web-push VAPID encryption. Proves the wiring (rule sync → crossing → claim → encrypted push → stamped delivery row → ACK); it says nothing about real
# SmartAPI / FCM latency. Usage: bash scripts/daemon-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/key.pem" -out "$D/cert.pem" -days 1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" >/dev/null 2>&1
SMOKE_TLS_KEY="$D/key.pem" SMOKE_TLS_CERT="$D/cert.pem" NODE_EXTRA_CA_CERTS="$D/cert.pem" npx tsx scripts/daemon-smoke.ts
