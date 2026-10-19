#!/usr/bin/env python3
"""Genera ANON_KEY y SERVICE_ROLE_KEY (JWT HS256) desde JWT_SECRET.

Uso:
  python3 infra/supabase/gen-keys.py '<JWT_SECRET>'
  JWT_SECRET='...' python3 infra/supabase/gen-keys.py

Solo stdlib. Expiración fija 2030-01-01 como el self-hosted oficial.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign(payload: dict, secret: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{b64url(sig)}"


def main() -> None:
    secret = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("JWT_SECRET", "")).strip()
    if len(secret) < 32:
        print("JWT_SECRET debe tener 32+ caracteres", file=sys.stderr)
        sys.exit(1)
    iat = int(time.time())
    exp = 1893456000  # 2030-01-01
    anon = sign({"role": "anon", "iss": "supabase", "iat": iat, "exp": exp}, secret)
    service = sign({"role": "service_role", "iss": "supabase", "iat": iat, "exp": exp}, secret)
    print(f"ANON_KEY={anon}")
    print(f"SERVICE_ROLE_KEY={service}")


if __name__ == "__main__":
    main()
