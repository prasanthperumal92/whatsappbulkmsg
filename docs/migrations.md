# Database migrations

Migrations run as a deploy step (`npm run db:migrate`, wired in `vercel.ts`), against the environment's own database, before the new code goes live.

**Every change must be backward compatible: expand, then contract.** Pinned Workflow runs on an older deployment keep using the same database (§3.1), and a failed build leaves the old code serving on an already-migrated schema.

1. **Expand:** add the new column or table, nullable or with a default. Old code must still work.
2. **Migrate:** deploy code that writes both shapes, then backfill.
3. **Contract:** drop the old shape in a later pull request, once no running campaign can be pinned to a deployment that uses it.

Never rename or drop a column, or tighten a constraint, in the same release that stops using it.

To change the schema, edit `lib/db/schema.ts` and run `npm run db:generate`. Commit the generated SQL. Never edit a migration that has already been applied.
