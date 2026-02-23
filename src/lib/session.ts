import { SessionOptions } from "iron-session";
import type { SessionData } from "@/types/cloudflare";

export const sessionOptions: SessionOptions = {
  password:
    process.env.SESSION_SECRET ||
    "complex_password_at_least_32_characters_long_for_dev_only!!",
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
