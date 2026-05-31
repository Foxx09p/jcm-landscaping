# Managed Database Migration Boundary

The current private GitHub repository is a prototype persistence layer. It keeps Git history, does not provide database transactions across concurrent requests, and is not the intended production store for broader use.

Before enabling Stripe live mode or expanding production traffic, migrate these records behind the existing server-side repository boundary:

- users and trusted role assignments
- contractor applications and contractor profiles
- jobs and private buyer details
- job quotes and interests
- job messages and system messages
- final offers
- job status history and edit history
- schedules
- cancellations and disputes
- reviews
- support tickets
- audit logs and private-detail reveal logs
- Stripe account metadata
- job payment records, payment events, and payout records
- photo metadata

Move uploaded request and completion photos from GitHub contents storage to managed object storage with short-lived authorized URLs. Preserve the current rule that request photos may be shown to approved contractors for quoting while completion photos and private details are available only to the buyer, accepted contractor, and authorized admins.

Keep sensitive marketplace operations behind trusted API routes during migration. Do not move authorization, lifecycle checks, money calculations, Stripe webhook verification, payout release checks, refund eligibility, or audit creation into browser-only code.
