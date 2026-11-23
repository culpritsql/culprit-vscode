-- 001_clean_init.sql
-- Notice: Indexing a table created in the SAME migration file produces ZERO false-positive lock warnings,
-- and the SELECT statement below displays inline Culprit CodeLenses (`Paste EXPLAIN` / `Compare Plan`).

CREATE TABLE public.orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  status TEXT NOT NULL,
  total_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);
CREATE INDEX ix_orders_status_created_at ON public.orders (status, created_at DESC);

SELECT o.id, o.customer_id, o.total_cents, o.created_at
FROM public.orders o
WHERE o.status = 'paid'
  AND o.created_at >= '2026-10-01'
ORDER BY o.created_at DESC
LIMIT 50;
