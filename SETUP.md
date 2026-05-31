# JCM Landscaping Setup

This project is a static website with Vercel serverless API routes and a Capacitor Android wrapper in `jcm-mobile`.

## GitHub Data Repository

The application stores records and uploaded photos in a separate private GitHub repository. The browser never receives a GitHub token. Sensitive marketplace actions pass through the trusted `/api/jobs/workflow` route, which enforces account, role, contractor approval, suspension, quote, accepted-contractor, lifecycle, payment, payout, refund, dispute, and private-detail rules.

The private repository is intended for a small prototype. Git history retains prior versions of changed files, and GitHub is not a transactional application database. Move users, roles, applications, jobs, quotes, messages, offers, schedules, payments, payouts, disputes, reviews, support tickets, audit logs, and photo metadata to a managed database and object storage before broader production use.

## Staff Roles

Privileged roles are controlled by `config/roles.json` in the private data repository. Add lowercase account emails with one of these values:

- `owner`: Full access, including private buyer details and ordinary user management.
- `admin`: Operational access, including private buyer details and ordinary user management. Cannot manage staff accounts.
- `moderator`: Review access for contractor applications, job status, and support tickets. Cannot view private buyer details or manage users.

See `ROLE_MANAGEMENT.md` for the editable JSON format. Removing an email removes its privileged access after the short server cache expires.

## Vercel Environment Variables

Set these before deploying:

- `GITHUB_DATA_REPO`: Private repository in `owner/repository` form, such as `Foxx09p/jcm-landscaping-data`.
- `GITHUB_DATA_TOKEN`: Fine-grained GitHub token with repository contents read/write access to the private data repository. Server-side only.
- `AUTH_SESSION_SECRET`: Random secret with at least 32 characters. Server-side only.
- `MEDIA_URL_SECRET`: Separate random secret used to sign photo URLs. Recommended.
- `STRIPE_MODE`: Keep this set to `test` for the current implementation.
- `STRIPE_LIVE_ENABLED`: Keep this set to `false`. Live mode refuses to initialize unless this is explicitly changed to `true`.
- `STRIPE_TEST_SECRET_KEY`: Stripe test-mode restricted key where possible, or a test secret key if required. Server-side only.
- `STRIPE_TEST_PUBLISHABLE_KEY`: Stripe test-mode publishable key.
- `STRIPE_TEST_WEBHOOK_SECRET`: Test-mode webhook signing secret for `/api/stripe/webhook`.
- `STRIPE_LIVE_SECRET_KEY`: Leave empty until live launch approval.
- `STRIPE_LIVE_PUBLISHABLE_KEY`: Leave empty until live launch approval.
- `STRIPE_LIVE_WEBHOOK_SECRET`: Leave empty until live launch approval.
- `PLATFORM_PAYMENTS_REQUIRED`: Keep `true` to require approved contractors to complete Stripe Test Mode onboarding before paid-job quoting.
- `AUTO_RELEASE_ENABLED`: Keep `false`. Automatic release is disabled by default.
- `AUTO_RELEASE_AFTER_DAYS`: Placeholder release window if automatic release is reviewed and enabled later.
- `REQUIRE_EMAIL_VERIFICATION`: Keep `false` until a real email verification provider and resend workflow are configured. Do not enable this flag alone.
- `APP_BASE_URL`: Production app URL, such as `https://jcm-landscaping.com`.

Phone sign-in is intentionally unavailable until an SMS provider is configured. Email/password sign-in is active. Passwords are stored only as salted hashes in the private data repository.

## Stripe Dashboard

Configure Stripe Connect in test mode for contractor payouts. Contractor recipient accounts and hosted onboarding use Stripe Accounts v2. Buyer payments use hosted Checkout Sessions on the platform account. Contractor payout release uses separate charges and transfers after buyer completion confirmation or admin dispute resolution. Create a test-mode webhook endpoint using the deployment domain followed by `/api/stripe/webhook`.

Subscribe at minimum to:

- `account.updated`
- `account.external_account.updated`
- `checkout.session.completed`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.succeeded`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `payout.created`
- `payout.updated`
- `payout.paid`
- `payout.failed`

Do not put GitHub tokens, session secrets, Stripe secret keys, webhook secrets, bank details, or card numbers in frontend code or mobile app assets.

## Stripe Test Mode and Later Live Enablement

The checked-in default is intentionally test-only. Payment pages and the admin dashboard display `Sandbox / Test Mode`, and no real money should move while `STRIPE_MODE=test`.

Only enable live mode after legal, operational, security, refund, dispute, webhook, Connect, and database reviews are complete:

1. Move production data from GitHub JSON storage to a managed transactional database and move uploaded media to managed object storage.
2. Create least-privilege live Stripe restricted keys where supported, configure the live publishable key, and create the live webhook endpoint.
3. Set `STRIPE_LIVE_SECRET_KEY`, `STRIPE_LIVE_PUBLISHABLE_KEY`, and `STRIPE_LIVE_WEBHOOK_SECRET` in the deployment secret store.
4. Set `STRIPE_MODE=live`.
5. Set `STRIPE_LIVE_ENABLED=true` only as the final deliberate launch step.

Never put live keys in `.env.example`, source code, frontend assets, the mobile bundle, logs, or Git history.

## Mobile App

The editable mobile web source exists in `jcm-mobile/www`. Its API client sends requests to `https://jcm-landscaping.com` when loaded inside Capacitor. Keep its bundled HTML, JavaScript, privacy page, and terms page synchronized with the web files. After changing bundled website assets, run from `jcm-mobile`:

```bash
npx cap sync android
```

Then rebuild the APK. The existing `JCM-Landscaping-debug.apk` is a built artifact and is not automatically updated.
