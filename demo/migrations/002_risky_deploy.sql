-- 002_risky_deploy.sql
-- Open this file in VS Code / Cursor to see Culprit SQL's live migration safety diagnostics:

-- 1. ERROR: CREATE INDEX CONCURRENTLY cannot execute inside an explicit transaction block
BEGIN;
CREATE INDEX CONCURRENTLY idx_invoices_customer_id ON public.invoices (customer_id);
COMMIT;

-- 2. WARNING: Blocking CREATE INDEX without CONCURRENTLY on an existing production table
CREATE INDEX idx_invoices_billing_email ON public.invoices (billing_email);

-- 3. WARNING: Unbounded DELETE statement with no top-level WHERE predicate
DELETE FROM public.expired_sessions;

-- 4. WARNING: Non-sargable LOWER() wrapper + leading-wildcard LIKE prevent B-tree index seeks
SELECT id, customer_id, total_cents, notes
FROM public.invoices
WHERE LOWER(billing_email) = 'vip@acme.io'
   OR notes LIKE '%refund%';
