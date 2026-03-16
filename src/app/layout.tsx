import type { Metadata } from "next";
import { Suspense } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider, FilterProvider } from "@/lib/store";
import { ThemeProvider } from "@/lib/theme";
import AppShell from "@/components/layout/app-shell";

const geistSans = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
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
