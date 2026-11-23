# Culprit SQL for VS Code: Interactive Demo Workspace

Open this `demo/` folder directly in **VS Code**, **Cursor**, or **Windsurf** to try every extension capability in 60 seconds:

```sh
code demo
```

When prompted in the bottom-right corner, install the recommended extension **`culpritsql.culprit-sql`** (from VS Code Marketplace or Open VSX).

## 5 Things to Try

1. **Zero-Click Custom Plan Viewer**
   - Double-click [`plans/checkout-before.explain.json`](./plans/checkout-before.explain.json), [`plans/customer-key-lookup.sqlplan`](./plans/customer-key-lookup.sqlplan), or [`plans/mysql-invoice-report.plan.json`](./plans/mysql-invoice-report.plan.json) in Explorer to inspect interactive operator flow graphs, disk spills, Key Lookups, and missing index SQL.
2. **Side-by-Side Before vs After Plan Comparison (392x Speedup)**
   - In Explorer, select both [`plans/checkout-before.explain.json`](./plans/checkout-before.explain.json) and [`plans/checkout-after.explain.json`](./plans/checkout-after.explain.json), right-click, and click **Culprit: Compare Two Execution Plans**.
3. **Deadlock Cycle Graph Viewer**
   - Double-click [`deadlocks/checkout-vs-fulfillment.xdl`](./deadlocks/checkout-vs-fulfillment.xdl) to visualize the lock wait cycle and victim session.
   - Open [`deadlocks/postgres-deadlock.log`](./deadlocks/postgres-deadlock.log), select all text (`Cmd+A` / `Ctrl+A`), right-click, and choose **Culprit: Explain Selected Plan / Deadlock**.
4. **Inline SQL CodeLens & Migration Safety Diagnostics**
   - Open [`migrations/001_clean_init.sql`](./migrations/001_clean_init.sql) to see `⚡ Culprit: Paste EXPLAIN · ⇄ Compare Plan` CodeLenses and zero false-positive warnings on newly created tables.
   - Open [`migrations/002_risky_deploy.sql`](./migrations/002_risky_deploy.sql) and [`src/ordersRepo.ts`](./src/ordersRepo.ts) to see live underlines for `CREATE INDEX CONCURRENTLY` inside `BEGIN ... COMMIT`, blocking `CREATE INDEX` on existing tables, `DELETE` without `WHERE`, non-sargable `LOWER(col)` predicates, and leading-wildcard `LIKE '%...'` filters inside TypeScript `sql\`...\`` templates.
5. **Interactive Studio & Redacted Share Links**
   - Press **`Cmd+Shift+E`** (`Ctrl+Shift+E` on Windows/Linux) from any editor to open **Culprit SQL Studio**, load built-in samples, export standalone HTML/Markdown reports, or click **Share Redacted Link** to generate a literal-scrubbed `explain.culpritsql.com` URL.
