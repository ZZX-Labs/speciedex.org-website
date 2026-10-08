from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _b64u_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64u_decode(value: str) -> bytes:
    text = str(value or "").strip()
    text += "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


def _fingerprint(value: str) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch in "0123456789ABCDEF")


@dataclass
class AdminAuthConfig:
    rp_id: str
    origin: str
    gpg_fingerprint: str
    credential_id: str
    public_key_pem: bytes
    session_seconds: int = 900

    @classmethod
    def from_environment(cls) -> "AdminAuthConfig | None":
        fingerprint = _fingerprint(os.environ.get("SPECIEDEX_ADMIN_GPG_FINGERPRINT", ""))
        credential_id = os.environ.get("SPECIEDEX_ADMIN_WEBAUTHN_CREDENTIAL_ID", "").strip()
        rp_id = os.environ.get("SPECIEDEX_WEBAUTHN_RP_ID", "speciedex.org").strip()
        origin = os.environ.get("SPECIEDEX_WEBAUTHN_ORIGIN", "https://speciedex.org").strip()
        pem_value = os.environ.get("SPECIEDEX_ADMIN_WEBAUTHN_PUBLIC_KEY_PEM", "")
        pem_path = os.environ.get("SPECIEDEX_ADMIN_WEBAUTHN_PUBLIC_KEY_FILE", "")
        if pem_path:
            try:
                pem_value = Path(pem_path).read_text(encoding="utf-8")
            except OSError:
                pem_value = ""
        if not (fingerprint and credential_id and pem_value and rp_id and origin):
            return None
        if len(fingerprint) not in {40, 64}:
            return None
        try:
            _b64u_decode(credential_id)
        except Exception:
            return None
        if "BEGIN PUBLIC KEY" not in pem_value and "BEGIN EC PUBLIC KEY" not in pem_value:
            return None
        return cls(
            rp_id=rp_id,
            origin=origin,
            gpg_fingerprint=fingerprint,
            credential_id=credential_id,
            public_key_pem=pem_value.encode("utf-8"),
            session_seconds=max(60, min(86400, int(os.environ.get("SPECIEDEX_ADMIN_SESSION_SECONDS", "900")))),
        )


class AdminAuthService:
    """Small in-memory WebAuthn assertion verifier for the terminal daemon.

    It intentionally implements authentication only. Any future privileged API
    action must call ``validate_session`` server-side; changing browser state or
    localStorage can never authorize a backend operation.
    """

    def __init__(self, config: AdminAuthConfig | None = None) -> None:
        self.config = config if config is not None else AdminAuthConfig.from_environment()
        self._lock = threading.RLock()
        self._challenges: dict[str, dict[str, Any]] = {}
        self._sessions: dict[str, float] = {}
        self._sign_count = 0

    @property
    def enabled(self) -> bool:
        return self.config is not None

    def public_status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": "server_verified_webauthn",
            "rp_id": self.config.rp_id if self.config else "speciedex.org",
            "origin": self.config.origin if self.config else None,
            "gpg_fingerprint_configured": bool(self.config and self.config.gpg_fingerprint),
            "hardware_credential_configured": bool(self.config and self.config.credential_id),
        }

    def _purge(self) -> None:
        now = time.time()
        self._challenges = {
            key: value for key, value in self._challenges.items()
            if float(value.get("expires_at", 0)) > now
        }
        self._sessions = {key: expires for key, expires in self._sessions.items() if expires > now}

    def challenge(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.config:
            return 503, {"error": "admin_auth_not_configured"}
        fingerprint = _fingerprint(payload.get("gpg_fingerprint", ""))
        if not secrets.compare_digest(fingerprint, self.config.gpg_fingerprint):
            return 403, {"error": "admin_identity_mismatch"}
        challenge = secrets.token_bytes(32)
        challenge_id = _b64u_encode(secrets.token_bytes(18))
        with self._lock:
            self._purge()
            self._challenges[challenge_id] = {
                "challenge": challenge,
                "expires_at": time.time() + 120,
                "fingerprint": fingerprint,
            }
        return 200, {
            "challenge_id": challenge_id,
            "challenge": _b64u_encode(challenge),
            "rpId": self.config.rp_id,
            "timeout": 60000,
            "allowCredentials": [{
                "type": "public-key",
                "id": self.config.credential_id,
                "transports": ["usb", "nfc"],
            }],
        }

    def _verify_signature(self, signature: bytes, signed_data: bytes) -> None:
        assert self.config is not None
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
        except ImportError as exc:  # optional daemon-only dependency
            raise ValueError("cryptography_package_required_for_admin_webauthn") from exc
        key = serialization.load_pem_public_key(self.config.public_key_pem)
        if isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(signature, signed_data, ec.ECDSA(hashes.SHA256()))
        elif isinstance(key, rsa.RSAPublicKey):
            key.verify(signature, signed_data, padding.PKCS1v15(), hashes.SHA256())
        elif isinstance(key, ed25519.Ed25519PublicKey):
            key.verify(signature, signed_data)
        else:
            raise ValueError("unsupported_webauthn_public_key")

    def verify(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.config:
            return 503, {"error": "admin_auth_not_configured"}
        challenge_id = str(payload.get("challenge_id") or "")
        fingerprint = _fingerprint(payload.get("gpg_fingerprint", ""))
        assertion = payload.get("assertion")
        if not challenge_id or not isinstance(assertion, dict):
            return 400, {"error": "invalid_webauthn_assertion"}
        with self._lock:
            self._purge()
            challenge = self._challenges.pop(challenge_id, None)
        if not challenge:
            return 400, {"error": "expired_or_unknown_challenge"}
        if not secrets.compare_digest(fingerprint, self.config.gpg_fingerprint):
            return 403, {"error": "admin_identity_mismatch"}
        if str(assertion.get("id") or "") != self.config.credential_id and str(assertion.get("rawId") or "") != self.config.credential_id:
            return 403, {"error": "unrecognized_hardware_credential"}
        try:
            response = assertion["response"]
            auth_data = _b64u_decode(response["authenticatorData"])
            client_json = _b64u_decode(response["clientDataJSON"])
            signature = _b64u_decode(response["signature"])
            client = json.loads(client_json.decode("utf-8"))
            if client.get("type") != "webauthn.get":
                raise ValueError("wrong_client_data_type")
            if client.get("origin") != self.config.origin:
                raise ValueError("origin_mismatch")
            expected_challenge = _b64u_encode(challenge["challenge"])
            if not secrets.compare_digest(str(client.get("challenge") or ""), expected_challenge):
                raise ValueError("challenge_mismatch")
            if len(auth_data) < 37:
                raise ValueError("authenticator_data_too_short")
            expected_rp_hash = hashlib.sha256(self.config.rp_id.encode("utf-8")).digest()
            if not secrets.compare_digest(auth_data[:32], expected_rp_hash):
                raise ValueError("rp_id_hash_mismatch")
            flags = auth_data[32]
            if not (flags & 0x01):
                raise ValueError("user_presence_required")
            if not (flags & 0x04):
                raise ValueError("user_verification_required")
            sign_count = int.from_bytes(auth_data[33:37], "big")
            signed_data = auth_data + hashlib.sha256(client_json).digest()
            self._verify_signature(signature, signed_data)
            with self._lock:
                if sign_count and self._sign_count and sign_count <= self._sign_count:
                    raise ValueError("non_monotonic_signature_counter")
                if sign_count:
                    self._sign_count = sign_count
                token = _b64u_encode(secrets.token_bytes(32))
                expires_at = time.time() + self.config.session_seconds
                self._sessions[token] = expires_at
        except Exception as exc:
            return 403, {"error": "webauthn_verification_failed", "reason": str(exc)}
        return 200, {
            "ok": True,
            "role": "admin",
            "session_token": token,
            "session_expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at)),
        }

    def validate_session(self, token: str) -> bool:
        with self._lock:
            self._purge()
            expires = self._sessions.get(str(token or ""))
            return bool(expires and expires > time.time())

    def logout(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        token = str(payload.get("session_token") or "")
        if token:
            with self._lock:
                self._sessions.pop(token, None)
        return 200, {"ok": True, "role": "public"}
