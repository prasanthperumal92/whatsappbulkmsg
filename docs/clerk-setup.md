# Clerk and Neon setup (part of T1.2)

Dashboard settings the code relies on. Do these on the development instance (previews) and the production instance.

## Clerk

1. **Sign-in options:** email verification code and Google. No passwords.
2. **Restrictions → Sign-up mode: Restricted.** This is what makes "no public sign-up" true. The app has no sign-up page, but Clerk's own API would otherwise still accept sign-ups.
3. **Sessions → Customize session token:** add `{ "email": "{{user.primary_email_address}}" }`. Without it the app still works, but each request makes an extra call to Clerk's API. Keep this claim as the primary address only, because the app trusts it as verified.
4. **First team member:** set `TEAM_BOOTSTRAP_EMAILS`, and invite the same address from the Clerk dashboard. After that, adding someone on Settings → Team sends their invitation.

To check: SEC-01 signs in with an email that isn't on the list, and must be refused.

## Neon: previews must not hold production data

§12 requires that production contacts never appear on preview URLs. **A Neon branch made from `main` is a full copy of its data**, contacts included. Create preview branches from an empty parent that has the schema but no data (for example a schema-only branch), not from `main`. Check this before the first real import reaches production.

## Variables

See `.env.example`. Generate each of `APP_ENCRYPTION_KEY`, `CRON_SECRET` and `EMAIL_UNSUBSCRIBE_SECRET` separately per environment, so that production values never reach a preview.
