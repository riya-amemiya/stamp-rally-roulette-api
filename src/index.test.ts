import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./index";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const draw = (id: string, ts = "2026-11-01T01:00:00.000Z", fallback = false) => ({
  id,
  ts,
  prizeId: "p_atari",
  prizeName: "Sticker set",
  prizeColor: "#3984FD",
  fallback,
});

const row = (id: string, ts = "2026-11-01T01:00:00.000Z") => ({
  transaction_id: id,
  timestamp: ts,
  prize_id: "p_atari",
  prize_name: "Sticker set",
  prize_color: "#3984FD",
  fallback_applied: 0,
});

const prizes = [{ id: "p_atari", stock: "Infinity" }];
const settings = { conferenceName: "TSKaigi" };

const snapshot = (history: ReadonlyArray<ReturnType<typeof draw>>) => ({
  prizes,
  settings,
  history,
});

const request = (method: string, path: string, body?: unknown, auth = "Bearer test-token") =>
  app.request(
    path,
    {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

const rows = async () =>
  (await env.DB.prepare("SELECT * FROM draws ORDER BY transaction_id").all()).results;

const storedState = async () =>
  (await env.DB.prepare("SELECT prizes, settings FROM state").all()).results;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM draws"), env.DB.prepare("DELETE FROM state")]);
});

describe("POST /snapshot", () => {
  describe("when the bearer token is wrong", () => {
    it("responds 401 and stores nothing", async () => {
      expect(
        (await request("POST", "/snapshot", snapshot([draw("T1")]), "Bearer wrong")).status,
      ).toBe(401);
      expect(await rows()).toEqual([]);
    });
  });

  describe("when the body is not a snapshot", () => {
    it("responds 400", async () => {
      expect((await request("POST", "/snapshot", { history: [] })).status).toBe(400);
    });
  });

  describe("when a history entry lacks the prize color", () => {
    it("responds 400", async () => {
      const { prizeColor: _, ...entry } = draw("T1");
      expect(
        (await request("POST", "/snapshot", { prizes, settings, history: [entry] })).status,
      ).toBe(400);
    });
  });

  describe("when the body is a snapshot", () => {
    it("stores each draw as a row with the CSV columns and the prize color", async () => {
      expect(
        (await request("POST", "/snapshot", snapshot([draw("T1", undefined, true)]))).status,
      ).toBe(204);
      expect(await rows()).toEqual([{ ...row("T1"), fallback_applied: 1 }]);
    });

    it("keeps a single row when the same draw arrives twice", async () => {
      await request("POST", "/snapshot", snapshot([draw("T1")]));
      await request("POST", "/snapshot", snapshot([draw("T1")]));
      expect(await rows()).toEqual([row("T1")]);
    });

    it("adds the draws missing from D1 and keeps the draws only D1 has", async () => {
      await request("POST", "/snapshot", snapshot([draw("T0"), draw("T1")]));
      await request("POST", "/snapshot", snapshot([draw("T1"), draw("T2")]));
      expect(await rows()).toEqual([row("T0"), row("T1"), row("T2")]);
    });

    it("replaces the stored prizes and settings with the latest ones", async () => {
      await request("POST", "/snapshot", snapshot([]));
      await request("POST", "/snapshot", { ...snapshot([]), settings: { conferenceName: "Next" } });
      expect(await storedState()).toEqual([
        {
          prizes: '[{"id":"p_atari","stock":"Infinity"}]',
          settings: '{"conferenceName":"Next"}',
        },
      ]);
    });
  });
});

describe("PUT /snapshot", () => {
  it("replaces every draw in D1 with the device history", async () => {
    await request("POST", "/snapshot", snapshot([draw("T0")]));
    expect((await request("PUT", "/snapshot", snapshot([draw("T1")]))).status).toBe(204);
    expect(await rows()).toEqual([row("T1")]);
  });
});

describe("DELETE /draws", () => {
  describe("when the body does not name a draw", () => {
    it("responds 400", async () => {
      expect((await request("DELETE", "/draws", { prizes, settings, id: "T1" })).status).toBe(400);
    });
  });

  describe("when the body names a stored draw", () => {
    it("removes only that draw and replaces the stored prizes and settings", async () => {
      await request("POST", "/snapshot", snapshot([draw("T1"), draw("T2")]));
      const restocked = [{ id: "p_atari", stock: 3 }];
      expect(
        (
          await request("DELETE", "/draws", {
            prizes: restocked,
            settings,
            id: "T1",
            ts: "2026-11-01T01:00:00.000Z",
          })
        ).status,
      ).toBe(204);
      expect(await rows()).toEqual([row("T2")]);
      expect(await storedState()).toEqual([
        { prizes: '[{"id":"p_atari","stock":3}]', settings: '{"conferenceName":"TSKaigi"}' },
      ]);
    });
  });
});

describe("GET /snapshot", () => {
  describe("when nothing has been saved", () => {
    it("responds 404", async () => {
      expect((await request("GET", "/snapshot")).status).toBe(404);
    });
  });

  describe("when a snapshot has been saved", () => {
    it("returns the prizes, settings, and history with the newest draw first", async () => {
      await request(
        "POST",
        "/snapshot",
        snapshot([draw("T1"), draw("T2", "2026-11-01T02:00:00.000Z", true)]),
      );
      const res = await request("GET", "/snapshot");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        prizes,
        settings,
        history: [draw("T2", "2026-11-01T02:00:00.000Z", true), draw("T1")],
      });
    });
  });
});

describe("CORS preflight from tskaigi.org", () => {
  it("is answered without a bearer token", async () => {
    const res = await app.request(
      "/snapshot",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://tskaigi.org",
          "Access-Control-Request-Method": "DELETE",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://tskaigi.org");
  });
});
