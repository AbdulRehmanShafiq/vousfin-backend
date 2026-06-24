# Design — Hardening & Auth Completion Pass (2026-06-24)

Post Phase 1–9 hardening: fix confirmed bugs, complete authentication (email verification + Google), QA-sweep the Phase 6–9 modules, partial Urdu, and audit feature completeness.

## Decisions (from the user)
- **Google login:** user will create + provide OAuth credentials; build the full flow regardless and verify live once creds are set.
- **Email verification:** required for **everyone** (existing users too). Resend/verify flow must be bulletproof and tested **before** flipping the production flag; verify the owner's own account first so nobody is locked out.
- **Urdu:** nav + common UI + key pages only (not every deep form).

## Workstreams

### W1 — MFA fix (confirmed bug)
`otplib@13.4.1` is ESM-first (`"type":"module"`) and fails to `require()` in the Vercel serverless (CommonJS) runtime → `GET /auth/mfa/setup` 500s ("Something went wrong").
- Replace otplib with a **zero-dependency RFC-6238 TOTP** built on Node `crypto` (`utils/totp.util.js`): `generateSecret()` (base32), `generateToken(secret)`, `verifyToken(secret, token, window=1)`, base32 encode/decode. Keep backup codes.
- Rewrite `services/mfa.service.js` to use the util; remove the otplib dependency.
- Re-verify: enroll → confirm → login challenge → verify, plus backup-code consumption.
- Acceptance: enable 2FA works live; login then requires the TOTP code; wrong code rejected; backup code works once.

### W2 — Email verification (everyone)
- `register` always sends a Brevo verification email; `login` rejects unverified with a clear, actionable error.
- Robust **resend verification** endpoint + a frontend "didn't get it? resend" affordance on the login/verify screens.
- `/verify-email` page consumes the token and activates the account.
- **Sequencing:** build + test resend/verify end-to-end and confirm the owner can verify, THEN set `SKIP_EMAIL_VERIFICATION=false` in Vercel. Provide a `scripts/` helper to verify the owner account directly if needed (safety hatch).
- Acceptance: new signup must verify before login; existing unverified user is blocked with a working resend; owner not locked out.

### W3 — Google login/signup
- Backend already wired (passport GoogleStrategy + `/auth/google` + `/auth/google/callback` + `googleCallback`). Ensure `googleCallback` redirects to a frontend route with the JWT; set `GOOGLE_CALLBACK_URL`.
- Frontend: "Continue with Google" button on Login + Register; a `/auth/google/success` route that captures the token from the redirect and completes login (sets token, navigates by setup/dashboard).
- Deliver exact Google Cloud Console setup steps (authorized origins + redirect URI). Once creds set in Vercel → verify live.
- Acceptance: clicking Google → Google consent → back into VousFin logged in (new or existing user).

### W4 — QA hardening sweep (Phases 6–9)
Module-by-module: Team, SoD, Internal Audit, Compliance Calendar, Leases, Impairment, AML, Benchmarking, 13-Week Cash, Security.
- **Validation (backend Joi + frontend):** percentage/rate fields constrained 0–100 (discount, tax, lease discount rate); monetary amounts ≥ 0; `periodEnd > periodStart`; lease term > 0; sample size within bounds; required fields enforced; numeric inputs reject negatives where invalid.
- **UI consistency:** unify `<select>`/dropdown styling (consistent bg/border/text colour across themes), button variants, spacing, empty/loading states across all new forms.
- **Functional:** click through each module, fix any errors/broken actions found.
- Acceptance: every Phase 6–9 module works end-to-end; no invalid input accepted; consistent visual language.

### W5 — Urdu (nav + common + key pages)
- Expand `src/i18n/locales/{en,ur}.json` to cover nav labels, common buttons/labels, and main screens (dashboard, transactions, settings hubs).
- Wire `t()` into `nav.config.js`, shared buttons/labels, and the key pages; verify RTL layout.
- Acceptance: switching to اردو visibly translates nav + common UI + key pages and flips to RTL cleanly.

### W6 — Feature-completeness audit
- Compare VousFin to a standard full-business accounting checklist (GL/double-entry, AR/AP, inventory, payroll, tax/FBR, multi-currency, fixed assets/depreciation, banking/reconciliation, budgeting, costing, reporting/statements, compliance, audit trail, multi-user/RBAC).
- Deliver a written gap report (`docs/superpowers/specs/2026-06-24-feature-completeness-audit.md`) listing covered areas + any genuine gaps with recommendations.

## Execution
- TDD for W1–W3 logic. Systematic per-module sweep for W4. Subagents for the bulk mechanical pieces (W4 sweep, W5 translation). Each workstream verified (full backend suite stays green, drift 0, frontend builds) and committed separately. Live verification in the browser where the change is user-visible (MFA, email verify, Google, key forms).
