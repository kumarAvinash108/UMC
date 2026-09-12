import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import type { SyncEvent } from "@ucm/protocol";
import { MemoryStore } from "./store.js";
import { buildRouter } from "./routes.js";
import { Hub } from "./ws.js";
import { rateLimit } from "./auth.js";

export function createApp() {
  const maxItemBytes = parseInt(process.env.MAX_ITEM_BYTES ?? "65536", 10);
  const maxHistory = parseInt(process.env.MAX_HISTORY_PER_USER ?? "1000", 10);
  const defaultExpiryDays = parseInt(process.env.DEFAULT_EXPIRY_DAYS ?? "7", 10);
  const ratePerMin = parseInt(process.env.RATE_LIMIT_PER_MIN ?? "120", 10);

  const store = new MemoryStore(maxHistory);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean);
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : true }));
  // Never log request bodies (they contain ciphertext); log only method/path/status.
  app.use((req, res, next) => {
    const t = Date.now();
    res.on("finish", () => {
      console.log(JSON.stringify({ m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t }));
    });
    next();
  });
  app.use("/v1", rateLimit(ratePerMin));

  let hub: Hub | undefined;
  const broadcast = (u: string, e: SyncEvent, x?: string) => hub?.broadcast(u, e, x);
  app.use("/v1", buildRouter(store, broadcast, { maxItemBytes, defaultExpiryDays, maxPage: 100 }));

  // Expiry sweeper (soft-delete; deletion propagates via WS + list filtering)
  const sweep = setInterval(() => store.sweepExpired(), 60_000);
  sweep.unref();

  return { app, store, setHub: (h: Hub) => { hub = h; } };
}

export function start(port = parseInt(process.env.PORT ?? "3000", 10)) {
  const { app, store, setHub } = createApp();
  const server = createServer(app);
  const hub = new Hub(store);
  hub.attach(server);
  setHub(hub);
  server.listen(port, () => console.log(`ucm sync listening on :${port}`));
  return { server, store, hub };
}
