/*
========================================================================
Speciedex.org
Terminal User Account + Administrative Authentication
========================================================================

Public identity/account helper and secure admin-authentication client.

Security boundary:
- ordinary account drafts may be stored locally;
- cryptographic account proofs must be verified by the configured server;
- administrator state is NEVER granted from localStorage/sessionStorage;
- admin-login requires a server challenge and a server-verified WebAuthn
  assertion for an allowlisted hardware credential (e.g. the designated
  YubiKey) bound by server policy to the configured administrator GPG
  fingerprint.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "UserAccount";
    const VERSION = "1.0.0";
    const CONFIG_URL = "/static/data/terminal/auth-config.json";
    const DRAFT_KEY = "speciedex-terminal:account-draft:v1";
    const CHALLENGE_KEY = "speciedex-terminal:account-challenge:v1";
    const SYMBOL = Symbol.for("speciedex.terminal.user-account.instance");

    function clean(value) {
        return String(value ?? "").trim();
    }

    function option(parsed, name) {
        return parsed?.options?.[name] ?? parsed?.options?.[name.replace(/-/g, "_")] ?? "";
    }

    function normalizeFingerprint(value) {
        return clean(value).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    }

    function validFingerprint(value) {
        const fp = normalizeFingerprint(value);
        return /^[A-F0-9]{40}$/.test(fp) || /^[A-F0-9]{64}$/.test(fp);
    }

    function validBitcoinAddress(value) {
        const address = clean(value);
        return /^(bc1|tb1|bcrt1)[ac-hj-np-z02-9]{11,90}$/i.test(address) || /^[123mn2][1-9A-HJ-NP-Za-km-z]{25,62}$/.test(address);
    }

    function validAlias(value) {
        return /^[a-z0-9][a-z0-9_.-]{1,31}$/i.test(clean(value));
    }

    function bytesFromBase64url(value) {
        const raw = clean(value).replace(/-/g, "+").replace(/_/g, "/");
        const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
        const binary = window.atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }

    function base64urlFromBytes(value) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer || value);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function randomToken(bytes = 24) {
        const data = new Uint8Array(bytes);
        window.crypto.getRandomValues(data);
        return base64urlFromBytes(data);
    }

    async function responseJSON(response) {
        let payload = {};
        try { payload = await response.json(); } catch (_) { /* diagnostic below */ }
        if (!response.ok) {
            throw new Error(clean(payload.error || payload.message) || `Authentication service returned HTTP ${response.status}.`);
        }
        return payload;
    }

    class UserAccountService {
        constructor(context) {
            this.context = context;
            this.root = context.root || document.documentElement;
            this.role = "public";
            this.adminSession = null;
            this.config = null;
            this.configPromise = null;
        }

        identity() {
            const draft = this.draft();
            return {
                role: this.role,
                username: this.role === "admin" ? "admin" : "public",
                authenticated: this.role === "admin",
                account: draft ? { alias: draft.alias, verified: Boolean(draft.verified) } : null,
                session_expires_at: this.adminSession?.session_expires_at || null
            };
        }

        can(access) {
            const needed = clean(access || "public").toLowerCase();
            if (needed === "public") return true;
            if (needed === "admin") return this.role === "admin" && Boolean(this.adminSession?.verified);
            if (needed === "user") return Boolean(this.draft()?.verified) || this.role === "admin";
            return false;
        }

        emitIdentity() {
            this.root.dispatchEvent(new CustomEvent("speciedex:terminal-identity-change", { detail: this.identity() }));
        }

        async loadConfig() {
            if (this.config) return this.config;
            if (!this.configPromise) {
                this.configPromise = fetch(CONFIG_URL, { cache: "no-store", credentials: "same-origin" })
                    .then(responseJSON)
                    .then(config => (this.config = config))
                    .finally(() => { this.configPromise = null; });
            }
            return this.configPromise;
        }

        draft() {
            try {
                const raw = window.localStorage?.getItem(DRAFT_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (_) {
                return null;
            }
        }

        createDraft({ alias, gpgFingerprint, bitcoinAddress }) {
            if (!validAlias(alias)) throw new Error("Account alias must be 2-32 letters, numbers, dots, underscores, or hyphens.");
            if (!validFingerprint(gpgFingerprint)) throw new Error("A 40- or 64-hex-character GPG fingerprint is required.");
            if (!validBitcoinAddress(bitcoinAddress)) throw new Error("A syntactically valid Bitcoin address is required.");
            const draft = {
                schema_version: 1,
                alias: clean(alias),
                gpg_fingerprint: normalizeFingerprint(gpgFingerprint),
                bitcoin_address: clean(bitcoinAddress),
                created_at: new Date().toISOString(),
                verified: false
            };
            window.localStorage?.setItem(DRAFT_KEY, JSON.stringify(draft));
            return draft;
        }

        challenge() {
            const draft = this.draft();
            if (!draft) throw new Error("Create an account draft first with account-create.");
            const challenge = {
                nonce: randomToken(),
                issued_at: new Date().toISOString(),
                statement: `Speciedex account proof\nalias=${draft.alias}\ngpg=${draft.gpg_fingerprint}\nbitcoin=${draft.bitcoin_address}\nnonce=${randomToken(16)}`
            };
            window.sessionStorage?.setItem(CHALLENGE_KEY, JSON.stringify(challenge));
            return challenge;
        }

        async verifyAccount(proof) {
            const config = await this.loadConfig();
            const endpoint = config?.endpoints?.account_verify;
            if (!config?.enabled || !endpoint) throw new Error("Server-side account verification is not configured on this deployment.");
            const challengeRaw = window.sessionStorage?.getItem(CHALLENGE_KEY);
            const challenge = challengeRaw ? JSON.parse(challengeRaw) : null;
            const draft = this.draft();
            if (!draft || !challenge) throw new Error("Create an account draft and challenge before submitting proofs.");
            const payload = await fetch(endpoint, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ draft, challenge, proof })
            }).then(responseJSON);
            if (!payload.verified) throw new Error("The account proof was not verified by the server.");
            draft.verified = true;
            draft.verified_at = new Date().toISOString();
            window.localStorage?.setItem(DRAFT_KEY, JSON.stringify(draft));
            this.emitIdentity();
            return payload;
        }

        async adminLogin() {
            const config = await this.loadConfig();
            if (!config?.enabled) throw new Error("Administrator authentication is disabled until static/data/terminal/auth-config.json is configured.");
            const fingerprint = normalizeFingerprint(config?.admin?.gpg_fingerprint);
            if (!validFingerprint(fingerprint)) throw new Error("Administrator GPG fingerprint is not configured.");
            if (!window.PublicKeyCredential || !navigator.credentials?.get) throw new Error("This browser does not provide WebAuthn hardware-credential support.");
            if (!window.isSecureContext) throw new Error("Hardware-key authentication requires HTTPS/secure context.");

            const challengeEndpoint = config?.endpoints?.admin_challenge;
            const verifyEndpoint = config?.endpoints?.admin_verify;
            if (!challengeEndpoint || !verifyEndpoint) throw new Error("Admin authentication endpoints are not configured.");

            const challengePayload = await fetch(challengeEndpoint, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gpg_fingerprint: fingerprint })
            }).then(responseJSON);

            const allowCredentials = (challengePayload.allowCredentials || config?.admin?.credential_ids || []).map(item => {
                const id = typeof item === "string" ? item : item.id;
                return {
                    type: "public-key",
                    id: bytesFromBase64url(id),
                    transports: typeof item === "object" ? item.transports : ["usb", "nfc"]
                };
            });
            if (!allowCredentials.length) throw new Error("No designated administrator hardware credential IDs are configured.");

            const credential = await navigator.credentials.get({
                publicKey: {
                    challenge: bytesFromBase64url(challengePayload.challenge),
                    rpId: clean(challengePayload.rpId || config.rp_id || "speciedex.org"),
                    allowCredentials,
                    userVerification: "required",
                    timeout: Number(challengePayload.timeout || 60000)
                }
            });
            if (!credential) throw new Error("No hardware credential assertion was returned.");

            const assertion = {
                id: credential.id,
                rawId: base64urlFromBytes(credential.rawId),
                type: credential.type,
                response: {
                    authenticatorData: base64urlFromBytes(credential.response.authenticatorData),
                    clientDataJSON: base64urlFromBytes(credential.response.clientDataJSON),
                    signature: base64urlFromBytes(credential.response.signature),
                    userHandle: credential.response.userHandle ? base64urlFromBytes(credential.response.userHandle) : null
                }
            };

            const verified = await fetch(verifyEndpoint, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    challenge_id: challengePayload.challenge_id,
                    assertion,
                    gpg_fingerprint: fingerprint
                })
            }).then(responseJSON);

            if (!verified.ok || verified.role !== "admin") throw new Error("The server rejected the administrator hardware assertion.");
            this.role = "admin";
            this.adminSession = {
                verified: true,
                session_token: verified.session_token || null,
                session_expires_at: verified.session_expires_at || null
            };
            this.emitIdentity();
            return this.identity();
        }

        async logout() {
            try {
                const config = await this.loadConfig();
                const endpoint = config?.endpoints?.logout;
                if (endpoint) await fetch(endpoint, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ session_token: this.adminSession?.session_token || null })
                });
            } catch (_) { /* local state is still cleared */ }
            this.role = "public";
            this.adminSession = null;
            this.emitIdentity();
            return this.identity();
        }
    }

    function initialize(context = {}) {
        const root = context.root || document.documentElement;
        const existing = root[SYMBOL];
        if (existing) return existing;
        const service = new UserAccountService(context);
        root[SYMBOL] = service;
        context.userAccount = service;
        context.registerService?.("user-account", service);
        queueMicrotask(() => service.emitIdentity());
        return service;
    }

    function service(context) {
        const result = context.userAccount || context.services?.get?.("user-account");
        if (!result) throw new Error("User-account service is unavailable.");
        return result;
    }

    const commands = [
        {
            name: "account-status", aliases: ["whoami"], category: "user", access: "public",
            description: "Show the current public/account/admin identity state.", usage: "account-status",
            handler: ({ context, writeJSON }) => writeJSON(service(context).identity())
        },
        {
            name: "account-create", category: "user", access: "public",
            description: "Create a local account draft identified by a GPG fingerprint and Bitcoin address.",
            usage: "account-create <alias> --gpg=<fingerprint> --bitcoin=<address>",
            handler: ({ args, parsed, context, writeJSON }) => writeJSON(service(context).createDraft({
                alias: args[0], gpgFingerprint: option(parsed, "gpg"), bitcoinAddress: option(parsed, "bitcoin")
            }))
        },
        {
            name: "account-challenge", category: "user", access: "public",
            description: "Generate the exact statement to sign with the account GPG key and Bitcoin key.", usage: "account-challenge",
            handler: ({ context, writeJSON }) => writeJSON(service(context).challenge())
        },
        {
            name: "account-verify", category: "user", access: "public",
            description: "Submit GPG and Bitcoin ownership proofs to the configured server verifier.",
            usage: "account-verify --gpg-signature=<base64> --bitcoin-signature=<base64>",
            handler: async ({ parsed, context, writeJSON }) => writeJSON(await service(context).verifyAccount({
                gpg_signature: option(parsed, "gpg-signature"), bitcoin_signature: option(parsed, "bitcoin-signature")
            }))
        },
        {
            name: "admin-login", category: "admin", access: "public",
            description: "Authenticate the designated administrator with the allowlisted hardware WebAuthn credential.", usage: "admin-login",
            handler: async ({ context, writeJSON }) => writeJSON(await service(context).adminLogin())
        },
        {
            name: "admin-status", category: "admin", access: "public",
            description: "Show administrator authentication availability and current session state.", usage: "admin-status",
            handler: async ({ context, writeJSON }) => {
                const account = service(context);
                let config = null;
                try { config = await account.loadConfig(); } catch (error) { config = { error: error.message }; }
                return writeJSON({ identity: account.identity(), configured: Boolean(config?.enabled), rp_id: config?.rp_id || null, gpg_fingerprint_configured: validFingerprint(config?.admin?.gpg_fingerprint || "") });
            }
        },
        {
            name: "admin-logout", category: "admin", access: "admin", adminOnly: true,
            description: "End the verified administrator session and restore the public prompt.", usage: "admin-logout",
            handler: async ({ context, writeJSON }) => writeJSON(await service(context).logout())
        }
    ];

    const api = Object.freeze({ name: MODULE_NAME, version: VERSION, initialize, mount: initialize, init: initialize, commands, UserAccountService });
    window.SpeciedexTerminalUserAccount = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;
    window.SpeciedexTerminalModules["user-account"] = api;
    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", { detail: { name: MODULE_NAME, module: api } }));
})(window, document);
