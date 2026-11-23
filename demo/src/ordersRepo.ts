// Open this TypeScript file in VS Code / Cursor to inspect:
// 1. Inline `⚡ Culprit: Paste EXPLAIN · ⇄ Compare Plan` CodeLenses above tagged SQL templates
// 2. Static SQL performance & safety diagnostics inside TypeScript template literals

function sql(strings: TemplateStringsArray, ...values: unknown[]): { text: string; values: unknown[] } {
  return { text: strings.join("$?"), values };
}

const Prisma = {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
    void strings;
    void values;
    return Promise.resolve([]);
  },
};

export interface OrderSummary {
  id: string;
  total_cents: number;
  created_at: string;
}

// Clean indexed query (hover or click CodeLens above `sql` to open Culprit Studio with this SQL attached)
export function buildRecentPaidOrdersQuery(customerId: string) {
  return sql`
    SELECT o.id, o.total_cents, o.created_at
    FROM public.orders o
    WHERE o.customer_id = ${customerId}
      AND o.status = 'paid'
    ORDER BY o.created_at DESC
    LIMIT 25
  `;
}

// Non-sargable LOWER(c.email) + leading-wildcard LIKE '%@vip.io' flagged inline by Culprit SQL
export async function findVipCustomersByEmail(emailInput: string) {
  return Prisma.$queryRaw<{ id: string; email: string }>`
    SELECT c.id, c.email
    FROM public.customers c
    WHERE LOWER(c.email) = ${emailInput.toLowerCase()}
       OR c.email LIKE '%@vip.io'
  `;
}

// Unbounded UPDATE without WHERE flagged inline before code review
export function buildDangerousResetQuery() {
  return sql`
    UPDATE public.feature_flags
    SET enabled = false
  `;
}
