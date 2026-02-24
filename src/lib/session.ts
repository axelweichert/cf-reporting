import { randomUUID } from "crypto";
import { SessionOptions } from "iron-session";
import type { SessionData } from "@/types/cloudflare";

const isProd = process.env.NODE_ENV === "production";
const secret = process.env.SESSION_SECRET;

if (isProd && (!secret || secret.length < 32)) {
  throw new Error(
    "SESSION_SECRET must be set to a random string of at least 32 characters in production. " +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}

export const sessionOptions: SessionOptions = {
  password: secret || randomUUID() + randomUUID(),
  cookieName: "cf-reporting-session",
  cookieOptions: {
    secure: isProd || process.env.SECURE_COOKIES === "true",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24, // 24 hours
    path: "/",
  },
};

export type { SessionData };
