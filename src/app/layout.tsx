import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider, FilterProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import AppShell from "@/components/layout/app-shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "cf-reporting",
  description: "Open-source Cloudflare reporting dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <AuthProvider>
            <FilterProvider>
              <Suspense>
                <AppShell>{children}</AppShell>
              </Suspense>
            </FilterProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
