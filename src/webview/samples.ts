import type { Engine } from "@culpritsql/plan-viewer";
import type { StudioMode } from "../webviewHtml";

export interface StudioSample {
  id: string;
  label: string;
  badge: string;
  mode: StudioMode;
  engine?: Engine;
  sql?: string;
  planText?: string;
  beforeName?: string;
  beforeText?: string;
  afterName?: string;
  afterText?: string;
  deadlockText?: string;
}

const PG_BEFORE_JSON = JSON.stringify(
  [
    {
      Plan: {
        "Node Type": "Limit",
        "Startup Cost": 48210.4,
        "Total Cost": 48215.9,
        "Plan Rows": 50,
        "Plan Width": 96,
        "Actual Startup Time": 318.4,
        "Actual Total Time": 319.2,
        "Actual Rows": 50,
        "Actual Loops": 1,
        "Shared Hit Blocks": 4120,
        "Shared Read Blocks": 18420,
        "Temp Read Blocks": 2304,
        "Temp Written Blocks": 2304,
        Plans: [
          {
            "Node Type": "Sort",
            "Sort Key": ["o.created_at DESC"],
            "Sort Method": "external merge",
            "Sort Space Used": 18432,
            "Sort Space Type": "Disk",
            "Startup Cost": 48210.4,
            "Total Cost": 48285.1,
            "Plan Rows": 29880,
            "Plan Width": 96,
            "Actual Startup Time": 318.1,
            "Actual Total Time": 318.9,
            "Actual Rows": 50,
            "Actual Loops": 1,
            "Shared Hit Blocks": 4120,
            "Shared Read Blocks": 18420,
            "Temp Read Blocks": 2304,
            "Temp Written Blocks": 2304,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Relation Name": "orders",
                Schema: "public",
                Alias: "o",
                Filter: "((status = 'paid'::text) AND (created_at >= '2026-10-01'::timestamptz))",
                "Rows Removed by Filter": 1458720,
                "Startup Cost": 0.0,
                "Total Cost": 39840.0,
                "Plan Rows": 3100,
                "Plan Width": 96,
                "Actual Startup Time": 0.08,
                "Actual Total Time": 264.4,
                "Actual Rows": 41280,
                "Actual Loops": 1,
                "Shared Hit Blocks": 4120,
                "Shared Read Blocks": 18420,
              },
            ],
          },
        ],
      },
      "Planning Time": 0.84,
      "Execution Time": 321.6,
    },
  ],
  null,
  2,
);

const PG_AFTER_JSON = JSON.stringify(
  [
    {
      Plan: {
        "Node Type": "Limit",
        "Startup Cost": 0.43,
        "Total Cost": 62.4,
        "Plan Rows": 50,
        "Plan Width": 96,
        "Actual Startup Time": 0.12,
        "Actual Total Time": 0.74,
        "Actual Rows": 50,
        "Actual Loops": 1,
        "Shared Hit Blocks": 54,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Scan Direction": "Backward",
            "Index Name": "ix_orders_status_created_at",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Index Cond": "((status = 'paid'::text) AND (created_at >= '2026-10-01'::timestamptz))",
            "Startup Cost": 0.43,
            "Total Cost": 1240.0,
            "Plan Rows": 41000,
            "Plan Width": 96,
            "Actual Startup Time": 0.11,
            "Actual Total Time": 0.68,
            "Actual Rows": 50,
            "Actual Loops": 1,
            "Shared Hit Blocks": 54,
          },
        ],
      },
      "Planning Time": 0.35,
      "Execution Time": 0.82,
    },
  ],
  null,
  2,
);

const MSSQL_DEADLOCK_XML = `<deadlock>
  <victim-list>
    <victimProcess id="process201"/>
  </victim-list>
  <process-list>
    <process id="process201" spid="74" clientapp="checkout-worker" loginname="app_checkout" hostname="worker-03" isolationlevel="read committed (2)" waitresource="KEY: 6:72057594041204736 (81944f3284a0)" waittime="1840" status="suspended" lastbatchstarted="2026-11-22T18:14:09.410">
      <executionStack>
        <frame procname="adhoc" sqlhandle="0x02">UPDATE dbo.inventory SET reserved = reserved + @qty WHERE sku_id = @sku;</frame>
      </executionStack>
      <inputbuf>BEGIN TRAN; UPDATE dbo.orders SET status = 'reserved' WHERE id = 91824; UPDATE dbo.inventory SET reserved = reserved + 2 WHERE sku_id = 4410;</inputbuf>
    </process>
    <process id="process202" spid="112" clientapp="fulfillment-sync" loginname="app_fulfillment" hostname="sync-01" isolationlevel="read committed (2)" waitresource="KEY: 6:72057594039894016 (44019a01b2c1)" waittime="1825" status="suspended" lastbatchstarted="2026-11-22T18:14:09.425">
      <executionStack>
        <frame procname="adhoc" sqlhandle="0x03">UPDATE dbo.orders SET shipped_at = SYSUTCDATETIME() WHERE id = @order_id;</frame>
      </executionStack>
      <inputbuf>BEGIN TRAN; UPDATE dbo.inventory SET on_hand = on_hand - 2 WHERE sku_id = 4410; UPDATE dbo.orders SET shipped_at = SYSUTCDATETIME() WHERE id = 91824;</inputbuf>
    </process>
  </process-list>
  <resource-list>
    <keylock hobtid="72057594039894016" dbid="6" objectname="shop.dbo.orders" indexname="PK_orders" id="lock_orders" mode="X">
      <owner-list><owner id="process201" mode="X"/></owner-list>
      <waiter-list><waiter id="process202" mode="U" requestType="wait"/></waiter-list>
    </keylock>
    <keylock hobtid="72057594041204736" dbid="6" objectname="shop.dbo.inventory" indexname="PK_inventory" id="lock_inventory" mode="X">
      <owner-list><owner id="process202" mode="X"/></owner-list>
      <waiter-list><waiter id="process201" mode="X" requestType="wait"/></waiter-list>
    </keylock>
  </resource-list>
</deadlock>`;

export const STUDIO_SAMPLES: StudioSample[] = [
  {
    id: "pg-spill",
    label: "PostgreSQL Disk Spill (322 ms)",
    badge: "PostgreSQL",
    mode: "plan",
    engine: "postgres",
    sql: "SELECT * FROM public.orders o WHERE o.status = 'paid' AND o.created_at >= '2026-10-01' ORDER BY o.created_at DESC LIMIT 50;",
    planText: PG_BEFORE_JSON,
  },
  {
    id: "pg-diff",
    label: "Before vs After Index (392x faster)",
    badge: "Compare",
    mode: "compare",
    engine: "postgres",
    beforeName: "Before (Seq Scan + Disk Sort)",
    beforeText: PG_BEFORE_JSON,
    afterName: "After (ix_orders_status_created_at)",
    afterText: PG_AFTER_JSON,
  },
  {
    id: "mssql-deadlock",
    label: "Checkout vs Fulfillment Lock Cycle",
    badge: "Deadlock",
    mode: "deadlock",
    deadlockText: MSSQL_DEADLOCK_XML,
  },
];
