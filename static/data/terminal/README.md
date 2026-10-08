# Speciedex terminal authentication

The public browser prompt is always `public@speciedex.org:~§` unless the
terminal daemon has successfully verified an administrator WebAuthn assertion.
Client-side storage alone never grants administrator access.

`auth-config.json` is public browser configuration.  Do not place private keys
or bearer tokens in it.  To enable `admin-login`, set its administrator GPG
fingerprint and enable the feature, then configure the terminal daemon with:

- `SPECIEDEX_ADMIN_GPG_FINGERPRINT`
- `SPECIEDEX_ADMIN_WEBAUTHN_CREDENTIAL_ID` (base64url credential ID of the
  designated hardware security key/YubiKey)
- `SPECIEDEX_ADMIN_WEBAUTHN_PUBLIC_KEY_PEM` or
  `SPECIEDEX_ADMIN_WEBAUTHN_PUBLIC_KEY_FILE`
- `SPECIEDEX_WEBAUTHN_RP_ID` (default `speciedex.org`)
- `SPECIEDEX_WEBAUTHN_ORIGIN` (default `https://speciedex.org`)
- `SPECIEDEX_ADMIN_SESSION_SECONDS` (default 900)

The daemon's WebAuthn verifier requires the Python `cryptography` package only
when administrator authentication is enabled. The ordinary public API and CI do
not require it.

The configured WebAuthn credential should be the FIDO2 credential enrolled on
the same designated physical YubiKey that carries the administrator's OpenPGP
key. The GPG fingerprint and WebAuthn credential ID are both allowlisted by the
server policy; the browser cannot grant itself administrator status.

Future privileged API handlers must validate the server-issued admin session
token before performing an administrative action. Merely changing the visible
prompt in browser developer tools is not authorization.
