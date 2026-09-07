import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { SyncEvent } from "@ucm/protocol";
import type { Store } from "./store.js";

interface Conn { ws: WebSocket; user_id: string; device_id: string | null; alive: boolean; }

/** Realtime fan-out registry. Swap with Redis pub/sub for multi-instance. */
export class Hub {
  conns = new Set<Conn>();
  constructor(private store: Store) {}

  attach(server: Server) {
    const wss = new WebSocketServer({ server, path: "/v1/sync" });
    wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/v1/sync", "http://x");
      const token = url.searchParams.get("token") ?? "";
      const sess = this.store.getSession(token);
      if (!sess) { ws.close(4401, "unauthorized"); return; }
      if (sess.device_id && this.store.isRevoked(sess.user_id, sess.device_id)) {
        ws.close(4403, "device revoked"); return;
      }
      const conn: Conn = { ws, user_id: sess.user_id, device_id: sess.device_id, alive: true };
      this.conns.add(conn);
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => this.conns.delete(conn));
      ws.send(JSON.stringify({ type: "hello", user_id: sess.user_id }));
    });
    const timer = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { try { c.ws.terminate(); } catch {} this.conns.delete(c); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch {}
      }
    }, 30_000);
    timer.unref();
  }

  broadcast(user_id: string, evt: SyncEvent, exceptDevice?: string) {
    const msg = JSON.stringify(evt);
    for (const c of this.conns) {
      if (c.user_id !== user_id) continue;
      if (exceptDevice && c.device_id === exceptDevice) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
    }
  }
}
