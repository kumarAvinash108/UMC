import type { Request, Response, NextFunction } from "express";
import type { Store } from "./store.js";

export interface AuthedRequest extends Request {
  user_id: string;
  session_token: string;
  device_id: string | null;
}

export function authMiddleware(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) { res.status(401).json({ error: "missing bearer token" }); return; }
    const sess = store.getSession(m[1]);
    if (!sess) { res.status(401).json({ error: "invalid session" }); return; }
    (req as AuthedRequest).user_id = sess.user_id;
    (req as AuthedRequest).session_token = sess.token;
    (req as AuthedRequest).device_id = sess.device_id;
    // Revoked device can no longer sync
    if (sess.device_id && store.isRevoked(sess.user_id, sess.device_id)) {
      res.status(403).json({ error: "device revoked" });
      return;
    }
    next();
  };
}

// Simple in-memory sliding-window rate limiter (per token). For multi-instance
// deploys, replace with Redis (see infra/).
export function rateLimit(maxPerMin: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.headers.authorization as string) ?? req.ip ?? "anon";
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > maxPerMin) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    next();
  };
}
