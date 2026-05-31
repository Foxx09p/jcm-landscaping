# JCM Landscaping Manual Verification

Use a deployed preview with a private GitHub data repository and Stripe test-mode keys. Never use live Stripe keys for this checklist.

## Accounts and Requests

1. Create a buyer account and sign in.
2. Submit a service request with address, phone, timing, budget, details, and optional photos.
3. Confirm the request appears in `My Requests`.
4. With `REQUIRE_EMAIL_VERIFICATION=true` in a dedicated preview, confirm an unverified request stays `pending_verification`. Keep this disabled in normal environments until a real email verification provider is configured.
5. Edit an open request after quotes exist and confirm submitted quotes move to `needs_resubmission`.
6. Cancel and reopen an eligible request.

## Contractor Approval and Quotes

1. Submit a contractor application and confirm it remains pending.
2. Sign in as admin, approve or reject the application, and confirm it immediately leaves the pending list.
3. Confirm an unapproved or suspended contractor cannot quote.
4. Confirm an approved contractor without Stripe Test Mode onboarding is prompted to complete `Payment Setup`.
5. Complete Stripe test onboarding, refresh status, add a service location, and submit a quote.
6. Confirm non-accepted contractors see only public request details and never receive address, phone, email, or exact coordinates.

## Accepted Job Workflow

1. As buyer, accept one contractor quote and confirm chat opens.
2. Reveal private details as the accepted contractor and verify an audit record is created.
3. Submit a contractor final offer with scope, final price, and proposed timing.
4. Accept the offer as buyer and confirm server-calculated 30% / 70% amounts.
5. Open Stripe Checkout in Test Mode and complete a test payment.
6. Deliver Stripe webhooks and confirm the job becomes `payment_held`.
7. Confirm payout release has not occurred yet.
8. Propose and confirm the schedule.
9. Mark the job in progress, upload optional completion photos, and mark complete.
10. Confirm completion as buyer and verify one Stripe test transfer releases 70% to the contractor while JCM retains 30%.
11. Attempt the completion action again and verify duplicate payout release is blocked or returns the existing release.

## Disputes and Admin

1. Repeat a job through contractor completion and open a buyer dispute instead of confirming.
2. Confirm the dispute blocks payout.
3. Resolve the dispute as admin with a required reason using full contractor release or full buyer refund.
4. Confirm `Jobs Queue` and `Schedule / Claimed Jobs` tabs are absent.
5. Confirm admin payment summaries show only non-sensitive Stripe IDs and never card or bank details.
6. Confirm private-detail reveals, force status actions, suspensions, application decisions, refunds, and releases create audit records.

## Safety

1. Run `npm run check`.
2. Run `npm test`.
3. Confirm `.env.example` contains no real keys.
4. Confirm `STRIPE_MODE=test` and `STRIPE_LIVE_ENABLED=false`.
5. Confirm setting `STRIPE_MODE=live` without `STRIPE_LIVE_ENABLED=true` fails closed.
