# Hardening & Auth Completion — Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD. Auth/MFA logic (W1–W3) is hand-written with TDD inline; bulk sweeps (W4, W5) run via focused subagents with their own specs. Steps use `- [ ]`.

**Goal:** Fix confirmed bugs (MFA, Urdu), complete auth (email verification for all + Google login), QA-harden Phase 6–9 modules, partial Urdu, and audit feature completeness.

**Tech Stack:** Node/Express/Mongoose backend (Vercel serverless, CommonJS), React 19/Vite frontend, Brevo SMTP, passport-google-oauth20, react-i18next.

## Global Constraints
- Backend runs on Vercel **serverless = CommonJS**; no ESM-only deps in the request path (this is what broke MFA).
- Every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Full backend suite must stay green; `node scripts/ledgerDrift.js` worst drift 0.
- Plain-language user-facing copy (no accountant/FBR jargon as primary text).
- Do NOT stage `outputs/cfo-reports/` or `.superpowers/`.

---

## W1 — MFA fix (zero-dependency TOTP)  [TDD, inline]
- [ ] **T1.1** Create `utils/totp.util.js`: `base32Encode(buf)`, `base32Decode(str)`, `generateSecret()` (20 random bytes → base32), `generateToken(secret, forTime?)` (RFC-6238, HMAC-SHA1, 30s step, 6 digits), `verifyToken(secret, token, window=1)`. Pure, uses Node `crypto`. TDD against an RFC-6238 known test vector.
- [ ] **T1.2** Rewrite `services/mfa.service.js` to use `totp.util` instead of `otplib` (keep generateSetup/confirmEnrollment/verifyToken/disableMFA + backup codes + otpauth:// URL built manually). Update `tests/unit/services/mfa.service.test.js`.
- [ ] **T1.3** Remove `otplib` from `package.json`; `npm install`. Verify `node -e "require('./services/mfa.service')"` loads clean.
- [ ] **T1.4** Full suite green + commit. Live-verify enable-2FA works on deployed app.

## W2 — Email verification for everyone  [TDD, inline; careful sequencing]
- [ ] **T2.1** Ensure `register` always sends a Brevo verification email (read `auth.service.register`); add/verify `resendVerification(email)` service + `POST /auth/resend-verification` route + validation.
- [ ] **T2.2** `login` rejects unverified with a clear ApiError (message: "Please verify your email first — we've sent you a link."). TDD both paths.
- [ ] **T2.3** Frontend: `/verify-email` page consumes token; Login screen shows a "Didn't get the email? Resend" action when login fails on verification; wire `authService.resendVerification`.
- [ ] **T2.4** Safety hatch: `scripts/verifyUserEmail.js <email>` to mark an account verified (dry-run default, `--apply`). Verify the owner's own account.
- [ ] **T2.5** Full suite green + commit + push. THEN (coordinated) set `SKIP_EMAIL_VERIFICATION=false` in Vercel + remove the forced default in `api/index.js`. Live-verify: new signup blocked until verify; resend works.

## W3 — Google login/signup  [build now, creds from user]
- [ ] **T3.1** Backend: verify `googleCallback` redirects to `${CLIENT_URL}/auth/google/success?token=...`; ensure new Google users get `isEmailVerified=true` (Google emails are pre-verified) so they bypass W2.
- [ ] **T3.2** Frontend: "Continue with Google" button component on Login + Register (links to `${API}/auth/google`); a `/auth/google/success` route that reads `?token`, stores it, decodes user, routes to setup/dashboard.
- [ ] **T3.3** Write `docs/superpowers/specs/google-oauth-setup-steps.md` — exact Google Cloud Console steps (authorized origins + redirect URI), hand to user.
- [ ] **T3.4** Commit. Once user provides creds → set in Vercel → live-verify the round trip.

## W4 — QA hardening sweep (Phases 6–9)  [subagent, with detailed spec]
- [ ] **T4.1** Backend validation pass: percentage/rate fields 0–100 (lease discountRate, any discount/tax %), monetary ≥ 0, `periodEnd > periodStart` (audit plan, compliance), lease term > 0, sample size 1–100, required fields — in the relevant Joi validations. TDD per validation.
- [ ] **T4.2** Frontend validation + UX: mirror the constraints on the forms (min/max/step on number inputs, disable submit on invalid); unify `<select>`/dropdown styling into a shared class/component; consistent button variants + spacing across Team/SoD/Audit/Calendar/Leases/AML/Benchmarking/13-week/Security pages.
- [ ] **T4.3** Functional click-through of each module; fix errors found.
- [ ] **T4.4** Full suite green + build clean + commit both repos.

## W5 — Urdu (nav + common + key pages)  [subagent]
- [ ] **T5.1** Expand `src/i18n/locales/{en,ur}.json` (nav + common + key-page strings).
- [ ] **T5.2** Wire `t()` into `nav.config.js`, shared Button/labels, and main pages (dashboard, transactions, settings hubs). Verify RTL.
- [ ] **T5.3** Build clean + commit.

## W6 — Feature-completeness audit  [report]
- [ ] **T6.1** Compare to a full-business accounting checklist; write `docs/superpowers/specs/2026-06-24-feature-completeness-audit.md` with covered areas + gaps + recommendations.

## Self-review
Spec coverage: W1↔MFA bug, W2↔email-verify decision, W3↔Google decision, W4↔QA/validation/UI, W5↔Urdu decision, W6↔feature audit. All 6 spec workstreams have tasks. No placeholders — each task names exact files/behaviour; full code written at execution under TDD.
