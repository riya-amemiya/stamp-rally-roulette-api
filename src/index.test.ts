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

const ts = "2026-11-01T01:00:00.000Z";

const draw = (id: string, fallback = false) => ({
  id,
  ts,
  prizeId: "p_atari",
  prizeName: "Sticker set",
  prizeColor: "#3984FD",
  fallback,
});

const row = (id: string) => ({
  transaction_id: id,
  timestamp: ts,
  prize_id: "p_atari",
  prize_name: "Sticker set",
  fallback_applied: 0,
});

const snapshot = (history: ReadonlyArray<ReturnType<typeof draw>>) => ({
  prizes: [{ id: "p_atari", stock: "Infinity" }],
  settings: { conferenceName: "TSKaigi" },
  history,
});

const request = (method: string, path: string, body: unknown, auth = "Bearer test-token") =>
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

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM draws"), env.DB.prepare("DELETE FROM state")]);
});

describe("POST /draws", () => {
  describe("when the bearer token is wrong", () => {
    it("responds 401 and stores nothing", async () => {
      expect((await request("POST", "/draws", draw("T1"), "Bearer wrong")).status).toBe(401);
      expect(await rows()).toEqual([]);
    });
  });

  describe("when the body is not a draw", () => {
    it("responds 400", async () => {
      expect((await request("POST", "/draws", { id: "T1" })).status).toBe(400);
    });
  });

  describe("when the body is a draw", () => {
    it("stores it as one row with the CSV columns", async () => {
      expect((await request("POST", "/draws", draw("T1", true))).status).toBe(204);
      expect(await rows()).toEqual([{ ...row("T1"), fallback_applied: 1 }]);
    });

    it("keeps a single row when the same draw arrives twice", async () => {
      await request("POST", "/draws", draw("T1"));
      await request("POST", "/draws", draw("T1"));
      expect(await rows()).toEqual([row("T1")]);
    });
  });
});

describe("POST /snapshot", () => {
  describe("when the body is not a snapshot", () => {
    it("responds 400", async () => {
      expect((await request("POST", "/snapshot", { history: [] })).status).toBe(400);
    });
  });

  describe("when the body is a snapshot", () => {
    it("adds the draws missing from D1 and keeps the draws only D1 has", async () => {
      await request("POST", "/draws", draw("T0"));
      await request("POST", "/draws", draw("T1"));
      expect((await request("POST", "/snapshot", snapshot([draw("T1"), draw("T2")]))).status).toBe(
        204,
      );
      expect(await rows()).toEqual([row("T0"), row("T1"), row("T2")]);
    });

    it("replaces the stored prizes and settings with the latest ones", async () => {
      await request("POST", "/snapshot", snapshot([]));
      await request("POST", "/snapshot", { ...snapshot([]), settings: { conferenceName: "Next" } });
      expect(await env.DB.prepare("SELECT prizes, settings FROM state").all()).toMatchObject({
        results: [
          {
            prizes: '[{"id":"p_atari","stock":"Infinity"}]',
            settings: '{"conferenceName":"Next"}',
          },
        ],
      });
    });
  });
});

describe("PUT /snapshot", () => {
  it("replaces every draw in D1 with the device history", async () => {
    await request("POST", "/draws", draw("T0"));
    expect((await request("PUT", "/snapshot", snapshot([draw("T1")]))).status).toBe(204);
    expect(await rows()).toEqual([row("T1")]);
  });
});

describe("CORS preflight from tskaigi.org", () => {
  it("is answered without a bearer token", async () => {
    const res = await app.request(
      "/draws",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://tskaigi.org",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://tskaigi.org");
  });
});
