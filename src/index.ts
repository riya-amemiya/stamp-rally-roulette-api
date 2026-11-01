import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { validator } from "hono/validator";

type Draw = {
  readonly id: string;
  readonly ts: string;
  readonly prizeId: string;
  readonly prizeName: string;
  readonly prizeColor: string;
  readonly fallback: boolean;
};

type State = {
  readonly prizes: ReadonlyArray<unknown>;
  readonly settings: object;
};

type Snapshot = State & {
  readonly history: ReadonlyArray<Draw>;
};

type Removal = State & {
  readonly id: string;
  readonly ts: string;
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
  "prizeColor" in v &&
  typeof v.prizeColor === "string" &&
  "fallback" in v &&
  typeof v.fallback === "boolean";

const isState = (v: unknown): v is State =>
  typeof v === "object" &&
  v !== null &&
  "prizes" in v &&
  Array.isArray(v.prizes) &&
  "settings" in v &&
  typeof v.settings === "object" &&
  v.settings !== null;

const isSnapshot = (v: unknown): v is Snapshot =>
  isState(v) && "history" in v && Array.isArray(v.history) && v.history.every(isDraw);

const isRemoval = (v: unknown): v is Removal =>
  isState(v) && "id" in v && typeof v.id === "string" && "ts" in v && typeof v.ts === "string";

const insertDraws = (db: D1Database, draws: ReadonlyArray<Draw>) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO draws (transaction_id, timestamp, prize_id, prize_name, prize_color, fallback_applied) SELECT value ->> 'id', value ->> 'ts', value ->> 'prizeId', value ->> 'prizeName', value ->> 'prizeColor', value ->> 'fallback' FROM json_each(?)",
    )
    .bind(JSON.stringify(draws));

const replaceState = (db: D1Database, state: State) =>
  db
    .prepare("INSERT OR REPLACE INTO state (id, prizes, settings, updated_at) VALUES (1, ?, ?, ?)")
    .bind(JSON.stringify(state.prizes), JSON.stringify(state.settings), new Date().toISOString());

const saveSnapshot = (db: D1Database, snapshot: Snapshot, overwrite: boolean) =>
  db.batch([
    ...(overwrite ? [db.prepare("DELETE FROM draws")] : []),
    insertDraws(db, snapshot.history),
    replaceState(db, snapshot),
  ]);

const snapshotValidator = validator("json", (v, c) =>
  isSnapshot(v) ? v : c.text("Bad Request", 400),
);

const app = new Hono<{ Bindings: Env }>();

app.use(cors({ origin: ["https://tskaigi.org", "http://localhost:5173"] }));
app.use((c, next) => bearerAuth<{ Bindings: Env }>({ token: c.env.WRITE_TOKEN })(c, next));

app.get("/snapshot", async (c) => {
  const [state, draws] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare("SELECT prizes, settings FROM state WHERE id = 1"),
    c.env.DB.prepare(
      "SELECT transaction_id AS id, timestamp AS ts, prize_id AS prizeId, prize_name AS prizeName, prize_color AS prizeColor, fallback_applied AS fallback FROM draws ORDER BY timestamp DESC LIMIT 2000",
    ),
  ]);
  const row = state?.results[0];
  if (typeof row?.prizes !== "string" || typeof row.settings !== "string") {
    return c.text("Not Found", 404);
  }
  return c.json({
    prizes: JSON.parse(row.prizes),
    settings: JSON.parse(row.settings),
    history: (draws?.results ?? []).map((d) => ({ ...d, fallback: d.fallback === 1 })),
  });
});

app.post("/snapshot", snapshotValidator, async (c) => {
  await saveSnapshot(c.env.DB, c.req.valid("json"), false);
  return c.body(null, 204);
});

app.put("/snapshot", snapshotValidator, async (c) => {
  await saveSnapshot(c.env.DB, c.req.valid("json"), true);
  return c.body(null, 204);
});

app.delete(
  "/draws",
  validator("json", (v, c) => (isRemoval(v) ? v : c.text("Bad Request", 400))),
  async (c) => {
    const removal = c.req.valid("json");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM draws WHERE transaction_id = ? AND timestamp = ?").bind(
        removal.id,
        removal.ts,
      ),
      replaceState(c.env.DB, removal),
    ]);
    return c.body(null, 204);
  },
);

export default app;
