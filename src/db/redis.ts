import { Redis } from "ioredis";
import crypto from "crypto";
import { env } from "../config/env.js";

let redisClient: Redis | null = null;
const inMemoryLocks = new Map<string, { token: string; expiresAt: number }>();

if (env.REDIS_URL) {
  try {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy(times: number) {
        if (times > 3) {
          console.warn(
            "⚠️ OCI Redis unreachable after 3 retries, falling back to local memory locks.",
          );
          return null;
        }
        return Math.min(times * 100, 2000);
      },
    });

    redisClient.on("connect", () => {
      console.log("✅ Connected to OCI Redis cluster");
    });

    redisClient.on("error", (err: any) => {
      console.warn("⚠️ Redis error encountered:", err.message);
    });

    redisClient.connect().catch((err: any) => {
      console.warn(
        "⚠️ Failed to connect to Redis initially. Operating with in-memory lock fallback:",
        err.message,
      );
    });
  } catch (err: any) {
    console.warn("⚠️ Redis initialization error, using in-memory locks:", err);
    redisClient = null;
  }
} else {
  console.log(
    "ℹ️ No REDIS_URL provided. Operating with in-memory mutex locks.",
  );
}

export async function acquireSessionLock(
  sessionId: string,
  ttlSeconds = 30,
): Promise<string | null> {
  const lockKey = `lock:session:${sessionId}`;
  const token = crypto.randomUUID();

  if (redisClient && redisClient.status === "ready") {
    try {
      const acquired = await redisClient.set(
        lockKey,
        token,
        "EX",
        ttlSeconds,
        "NX",
      );
      return acquired === "OK" ? token : null;
    } catch (err) {
      console.warn(
        "⚠️ Redis lock acquire failed, falling back to in-memory lock:",
        err,
      );
    }
  }

  const now = Date.now();
  const existing = inMemoryLocks.get(lockKey);
  if (existing && existing.expiresAt > now) {
    return null;
  }

  inMemoryLocks.set(lockKey, { token, expiresAt: now + ttlSeconds * 1000 });
  return token;
}

export async function releaseSessionLock(
  sessionId: string,
  token: string,
): Promise<boolean> {
  const lockKey = `lock:session:${sessionId}`;

  if (redisClient && redisClient.status === "ready") {
    try {
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const res = await redisClient.eval(luaScript, 1, lockKey, token);
      return res === 1;
    } catch (err) {
      console.warn("⚠️ Redis lock release failed, cleaning local lock:", err);
    }
  }

  const existing = inMemoryLocks.get(lockKey);
  if (existing && existing.token === token) {
    inMemoryLocks.delete(lockKey);
    return true;
  }
  return false;
}

export async function checkRedisHealth(): Promise<boolean> {
  if (!redisClient || redisClient.status !== "ready") {
    return true;
  }
  try {
    const pong = await redisClient.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

export { redisClient };
