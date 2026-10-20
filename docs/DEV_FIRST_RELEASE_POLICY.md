# DEV-first release policy — Tenant-POS

This repository follows the **AI Core** release sequence:

`feature/<issue>` → PR into `develop` → DEV CI/test/build → isolated DEV deployment → authenticated non-destructive E2E smoke tests → reviewed promotion PR → `main` → PROD deployment + post-release verification.

## Mandatory rules

1. New work targets `develop`, not `main`. No coding, data migrations, automation, CI bypasses, or urgent patches directly on PROD.
2. DEV uses its own Supabase database, environment variables, secrets, object storage, tenant/test data and worker credentials. **Never** use production database URLs, production WhatsApp destinations, payment API keys or real customer data in DEV. Fail closed if DEV secrets are unavailable.
3. A successful CI is necessary, **not sufficient**. Prove a DEV deployment serves the exact tested commit (where the service exposes SHA), then test login, tenant isolation, writes/reads, payment/invoice or WA actions with mocks/sandbox only, and review logs for regressions.
4. CI/test run on DEV must cover relevant services and must never send real WhatsApp messages, charge payments, post accounting entries, or modify PROD data.
5. Promotion requires positive, recorded DEV evidence for the exact commit and a reviewed non-squashed Git merge into `main`; production deploy must fail closed on missing evidence. Run smoke tests after PROD deployment, and roll back if they fail.
6. Do not deploy from `main` using Hostinger/Replit native Git auto-deploy while the GitHub release gate is missing or bypassable. Disable native auto-deploy or enforce manual, approved releases. Branch protection on `main` must require the checks and reviews; workflow files alone are not branch protection.
7. If a DEV environment is not provisioned/verified, mark it **BLOCKED** and do not release. No deployment to PROD is authorized by this document.

## Current target

PROD: Tenant POS Hostinger; DEV: separate staging environment connected to `develop` with a distinct database and secrets. Resolve and verify the live DEV URL before enabling automatic production releases.

This policy applies to GitHub CI/CD and human/operator-driven release actions. It does not implicitly authorize GitHub to touch external hosting or production databases.
