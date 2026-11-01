import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { validator } from "hono/validator";

type Draw = {
  readonly id: string;
  readonly ts: string;
  readonly prizeId: string;
  readonly prizeName: string;
  readonly fallback: boolean;
};

type Snapshot = {
  readonly prizes: ReadonlyArray<unknown>;
  readonly settings: object;
  readonly history: ReadonlyArray<Draw>;
};

const isDraw = (v: unknown): v is Draw =>
  typeof v === "object" &&
  v !== null &&
  "id" in v &&
  typeof v.id === "string" &&
  "ts" in v &&
  typeof v.ts === "string" &&
  !Number.isNaN(Date.parse(v.ts)) &&
  "prizeId" in v &&
  typeof v.prizeId === "string" &&
  "prizeName" in v &&
  typeof v.prizeName === "string" &&
  "fallback" in v &&
  typeof v.fallback === "boolean";

const isSnapshot = (v: unknown): v is Snapshot =>
  typeof v === "object" &&
  v !== null &&
  "prizes" in v &&
  Array.isArray(v.prizes) &&
  "settings" in v &&
  typeof v.settings === "object" &&
  v.settings !== null &&
  "history" in v &&
  Array.isArray(v.history) &&
  v.history.every(isDraw);

const insertDraws = (db: D1Database, draws: ReadonlyArray<Draw>) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO draws (transaction_id, timestamp, prize_id, prize_name, fallback_applied) SELECT value ->> 'id', value ->> 'ts', value ->> 'prizeId', value ->> 'prizeName', value ->> 'fallback' FROM json_each(?)",
    )
    .bind(JSON.stringify(draws));

const saveSnapshot = (db: D1Database, snapshot: Snapshot, overwrite: boolean) =>
  db.batch([
    ...(overwrite ? [db.prepare("DELETE FROM draws")] : []),
    insertDraws(db, snapshot.history),
    db
      .prepare("INSERT OR REPLACE INTO state (id, prizes, settings, updated_at) VALUES (1, ?, ?, ?)")
      .bind(
        JSON.stringify(snapshot.prizes),
        JSON.stringify(snapshot.settings),
        new Date().toISOString(),
      ),
  ]);

const snapshotValidator = validator("json", (v, c) =>
  isSnapshot(v) ? v : c.text("Bad Request", 400),
);

const app = new Hono<{ Bindings: Env }>();

app.use(cors({ origin: ["https://tskaigi.org", "http://localhost:5173"] }));
app.use((c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.WRITE_TOKEN })(c, next));

app.post(
  "/draws",
  validator("json", (v, c) => (isDraw(v) ? v : c.text("Bad Request", 400))),
  async (c) => {
    await insertDraws(c.env.DB, [c.req.valid("json")]).run();
    return c.body(null, 204);
  },
);

app.post("/snapshot", snapshotValidator, async (c) => {
  await saveSnapshot(c.env.DB, c.req.valid("json"), false);
  return c.body(null, 204);
});

app.put("/snapshot", snapshotValidator, async (c) => {
  await saveSnapshot(c.env.DB, c.req.valid("json"), true);
  return c.body(null, 204);
});

export default app;
