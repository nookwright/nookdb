//! Offline ed25519 license-token verification utility (dormant).
//!
//! Ships inert in the MIT core: exported from `lib.rs` but never invoked
//! by the free-tier codepath. External integrators (post-1.0) will
//! consume it without requiring a core release. No network calls;
//! algorithm is pinned (Ed25519); token format is a minimal
//! `<payload_b64url>.<sig_b64url>` JWT-ish.
//!
//! "Any milestone — dormant license-verify utility".

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct LicenseClaims {
    pub sub: String,
    pub tier: String,
    pub iat: u64,
    pub exp: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum NookLicenseError {
    #[error("[license] invalid token format: {msg}")]
    InvalidFormat { msg: String },
    #[error("[license] invalid signature")]
    InvalidSignature,
    #[error("[license] token expired at {exp}, current time {now}")]
    Expired { exp: u64, now: u64 },
    #[error("[license] malformed claims: {msg}")]
    MalformedClaims { msg: String },
}

/// Verify an ed25519-signed license token offline.
///
/// **Pre-1.0 dormant utility** — the MIT core never invokes this from the
/// free-tier path; external integrator (post-1.0) will consume it. No network
/// calls; algorithm pinned to Ed25519; no JWS header negotiation.
///
/// # Errors
///
/// Returns `NookLicenseError` for any failure: malformed token shape,
/// invalid base64, on-curve check failure, signature mismatch, JSON
/// parse failure, or `exp < now_unix_seconds`.
pub fn verify(
    token: &str,
    public_key: &[u8; 32],
    now_unix_seconds: u64,
) -> Result<LicenseClaims, NookLicenseError> {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signature, VerifyingKey};

    // 1. Split on '.', expect exactly 2 parts
    let (payload_b64, sig_b64) =
        token
            .split_once('.')
            .ok_or_else(|| NookLicenseError::InvalidFormat {
                msg: "expected <payload>.<sig>".to_string(),
            })?;
    if payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(NookLicenseError::InvalidFormat {
            msg: "empty payload or signature segment".to_string(),
        });
    }

    // 2. Decode signature (64 bytes for Ed25519)
    let mut sig_bytes = [0_u8; 64];
    Base64UrlUnpadded::decode(sig_b64, &mut sig_bytes).map_err(|e| {
        NookLicenseError::InvalidFormat {
            msg: format!("signature b64 decode: {e}"),
        }
    })?;
    let signature = Signature::from_bytes(&sig_bytes);

    // 3. Verify signature over the b64 payload bytes (JWT convention)
    let vk = VerifyingKey::from_bytes(public_key).map_err(|_| NookLicenseError::InvalidFormat {
        msg: "public key not on curve".to_string(),
    })?;
    vk.verify_strict(payload_b64.as_bytes(), &signature)
        .map_err(|_| NookLicenseError::InvalidSignature)?;

    // 4. Decode + parse the payload
    let payload_bytes = Base64UrlUnpadded::decode_vec(payload_b64).map_err(|e| {
        NookLicenseError::InvalidFormat {
            msg: format!("payload b64 decode: {e}"),
        }
    })?;
    let claims: LicenseClaims = serde_json::from_slice(&payload_bytes)
        .map_err(|e| NookLicenseError::MalformedClaims { msg: e.to_string() })?;

    // 5. Check expiration
    if claims.exp < now_unix_seconds {
        return Err(NookLicenseError::Expired {
            exp: claims.exp,
            now: now_unix_seconds,
        });
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use rand_core::{OsRng, RngCore};

    /// Generate a fresh `SigningKey` from OS randomness.
    ///
    /// Used instead of `SigningKey::generate` because that constructor is
    /// gated by ed25519-dalek's `rand_core` feature, which we do not
    /// enable on the runtime crate (this helper lives in `#[cfg(test)]`
    /// where `rand_core` is a dev-dependency).
    fn fresh_signing_key() -> SigningKey {
        let mut secret = [0_u8; 32];
        OsRng.fill_bytes(&mut secret);
        SigningKey::from_bytes(&secret)
    }

    fn make_token(claims: &serde_json::Value, sk: &SigningKey) -> String {
        let payload_json = serde_json::to_vec(claims).unwrap();
        let payload_b64 = Base64UrlUnpadded::encode_string(&payload_json);
        let signature = sk.sign(payload_b64.as_bytes());
        let sig_b64 = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        format!("{payload_b64}.{sig_b64}")
    }

    #[test]
    fn valid_token_verifies_with_correct_key() {
        let sk = fresh_signing_key();
        let pk = sk.verifying_key().to_bytes();
        let token = make_token(
            &serde_json::json!({
                "sub": "test-customer", "tier": "team",
                "iat": 1_700_000_000_u64, "exp": 9_999_999_999_u64,
            }),
            &sk,
        );
        let claims = verify(&token, &pk, 1_700_000_001).unwrap();
        assert_eq!(claims.sub, "test-customer");
        assert_eq!(claims.tier, "team");
        // Assert `iat` + `exp` to exercise full claims deserialization
        // (every `LicenseClaims` field surfaces correctly from the
        // base64-url payload).
        assert_eq!(claims.iat, 1_700_000_000);
        assert_eq!(claims.exp, 9_999_999_999);
    }

    #[test]
    fn tampered_signature_fails() {
        let sk = fresh_signing_key();
        let pk = sk.verifying_key().to_bytes();
        let mut token = make_token(
            &serde_json::json!({
                "sub": "x", "tier": "team",
                "iat": 1_700_000_000_u64, "exp": 9_999_999_999_u64,
            }),
            &sk,
        );
        let last = token.pop().unwrap();
        token.push(if last == 'A' { 'B' } else { 'A' });
        let err = verify(&token, &pk, 1_700_000_001).unwrap_err();
        assert!(
            matches!(
                err,
                NookLicenseError::InvalidSignature | NookLicenseError::InvalidFormat { .. }
            ),
            "expected InvalidSignature or InvalidFormat, got {err:?}",
        );
    }

    #[test]
    fn expired_token_fails() {
        let sk = fresh_signing_key();
        let pk = sk.verifying_key().to_bytes();
        let token = make_token(
            &serde_json::json!({
                "sub": "x", "tier": "team",
                "iat": 1_700_000_000_u64, "exp": 1_700_000_100_u64,
            }),
            &sk,
        );
        let err = verify(&token, &pk, 1_700_000_200).unwrap_err();
        match err {
            NookLicenseError::Expired { exp, now } => {
                assert_eq!(exp, 1_700_000_100);
                assert_eq!(now, 1_700_000_200);
            }
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    fn malformed_payload_fails_after_signature_ok() {
        let sk = fresh_signing_key();
        let pk = sk.verifying_key().to_bytes();
        let payload_b64 = Base64UrlUnpadded::encode_string(b"{\"garbage\":true}");
        let sig = sk.sign(payload_b64.as_bytes());
        let sig_b64 = Base64UrlUnpadded::encode_string(&sig.to_bytes());
        let token = format!("{payload_b64}.{sig_b64}");
        let err = verify(&token, &pk, 1_700_000_001).unwrap_err();
        assert!(
            matches!(err, NookLicenseError::MalformedClaims { .. }),
            "expected MalformedClaims, got {err:?}",
        );
    }

    #[test]
    fn invalid_format_fails() {
        // Each input below should map to `NookLicenseError::InvalidFormat`
        // via a distinct sub-path inside `verify`. Bundled into one test
        // to stay at "5 tests" per the plan while still exercising every
        // `InvalidFormat` construction site for line-coverage.
        let pk_zero = [0_u8; 32];

        // (a) No '.' separator → `split_once` returns None.
        let err = verify("not-a-jwt", &pk_zero, 0).unwrap_err();
        assert!(
            matches!(err, NookLicenseError::InvalidFormat { .. }),
            "no-dot: expected InvalidFormat, got {err:?}",
        );

        // (b) Empty payload segment.
        let err = verify(".validsig", &pk_zero, 0).unwrap_err();
        assert!(
            matches!(err, NookLicenseError::InvalidFormat { .. }),
            "empty-payload: expected InvalidFormat, got {err:?}",
        );

        // (c) Empty signature segment.
        let err = verify("payload.", &pk_zero, 0).unwrap_err();
        assert!(
            matches!(err, NookLicenseError::InvalidFormat { .. }),
            "empty-sig: expected InvalidFormat, got {err:?}",
        );

        // (d) Sig present but not valid base64 (illegal char '!').
        let err = verify("aGVsbG8.!!!!", &pk_zero, 0).unwrap_err();
        assert!(
            matches!(err, NookLicenseError::InvalidFormat { .. }),
            "bad-b64-sig: expected InvalidFormat, got {err:?}",
        );

        // (e) Sig decodes but public key is not on curve. Forge a
        // syntactically-valid 64-byte b64url-encoded signature alongside
        // a non-curve public key so we reach `VerifyingKey::from_bytes`
        // (lines covering "public key not on curve").
        let sk = fresh_signing_key();
        let token = make_token(
            &serde_json::json!({
                "sub": "x", "tier": "team",
                "iat": 1_700_000_000_u64, "exp": 9_999_999_999_u64,
            }),
            &sk,
        );
        // 0xFF... is not a valid Ed25519 verifying key encoding.
        let pk_bad = [0xFF_u8; 32];
        let err = verify(&token, &pk_bad, 1_700_000_001).unwrap_err();
        assert!(
            matches!(
                err,
                NookLicenseError::InvalidFormat { .. } | NookLicenseError::InvalidSignature
            ),
            "non-curve-pk: expected InvalidFormat or InvalidSignature, got {err:?}",
        );
    }
}
