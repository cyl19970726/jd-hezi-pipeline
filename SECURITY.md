# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/cyl19970726/jd-hezi-pipeline/security/advisories/new). Do not open a public issue for credentials, browser-session handling, private business data, unsafe external writes, or a way to bypass workflow safeguards.

Include the affected version or commit, impact, minimal reproduction, and any suggested mitigation. Redact shop/account identifiers. Never attach cookies, browser profiles, `.hezi/`, databases, customer/order data, or raw operational exports.

## Supported versions

Security fixes target the latest commit on `main` and the most recent tagged release. Older revisions may require upgrading.

## Operational responsibility

This project automates actions on external systems. Users must have permission to operate the account, follow platform terms and rate limits, keep credentials inside their own browser session, and verify every external write through supported read-back paths.
