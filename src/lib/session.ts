import { randomUUID } from "crypto";
import { SessionOptions } from "iron-session";
import type { SessionData } from "@/types/cloudflare";

const secret = process.env.SESSION_SECRET;

// Auto-generate a secret if none is provided. Sessions won't survive container
// restarts (users will need to re-enter their token), but the app will work
// out of the box without extra configuration.
const effectiveSecret = secret && secret.length >= 32
  ? secret
  : (() => {
      if (!secret || secret === "build-placeholder-00000000000000000000") {
        const generated = randomUUID() + randomUUID();
        console.warn(
          "SESSION_SECRET not set — using an auto-generated secret. " +
          "Sessions will not persist across container restarts. " +
          "Set SESSION_SECRET to a 32+ character string for persistent sessions."
        );
        return generated;
      }
      return randomUUID() + randomUUID();
    })();

export const sessionOptions: SessionOptions = {
  password: effectiveSecret,
  cookieName: "cf-reporting-session",
  cookieOptions: {
    secure: process.env.SECURE_COOKIES === "true",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24, // 24 hours
    path: "/",
  },
};

export type { SessionData };
