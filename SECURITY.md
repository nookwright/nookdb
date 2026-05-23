# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No (pre-release; please upgrade) |

## Reporting a Vulnerability

Please report security vulnerabilities privately via GitHub Security Advisories:

https://github.com/nookwright/nookdb/security/advisories/new

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation within 14 days for critical issues.

Do **not** open a public issue for security reports.

## Scope

In-scope:
- The published npm packages: `nookdb`, `@nookdb/react`, `@nookdb/electron`, `@nookdb/cli`, `@nookdb/binding`, `@nookdb/binding-<triple>`.
- The crates.io package: `nookdb-core`.

Out of scope:
- Third-party Electron app code that consumes NookDB.
- Vulnerabilities in upstream dependencies (`redb`, `napi-rs`, Node, Electron) — report those upstream first; we will track and ship updates.
