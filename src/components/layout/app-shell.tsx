"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Sidebar from "./sidebar";
import FilterBar from "./filter-bar";
import { useAuth } from "@/lib/store";
import ErrorBoundary from "@/components/ui/error-boundary";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { authenticated, capabilities, loading, setAuth, setLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    async function checkSession() {
      try {
        const res = await fetch("/api/auth/session");
        const data = await res.json();
        if (data.authenticated) {
          // Session exists, now fetch full capabilities (accounts, zones)
          const capsRes = await fetch("/api/auth/capabilities");
          if (capsRes.ok) {
            const caps = await capsRes.json();
            setAuth(true, caps);
          } else {
            // Session valid but caps failed – use slim data from session
            setAuth(true, {
              permissions: data.capabilities?.permissions || [],
              accounts: [],
              zones: [],
            });
          }
        } else if (pathname !== "/setup") {
          router.replace("/setup");
        }
      } catch {
        if (pathname !== "/setup") {
          router.replace("/setup");
        }
      } finally {
        setLoading(false);
      }
    }
    checkSession();
  }, [setAuth, setLoading, router, pathname]);

  // Setup page gets no shell
  if (pathname === "/setup") {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-orange-500" />
      </div>
    );
  }

  if (!authenticated) {
    return null;
  }

  const accounts = capabilities?.accounts || [];
  const zones = capabilities?.zones || [];
  const permissions = capabilities?.permissions || [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar collapsed={sidebarCollapsed} permissions={permissions} />
      <div className={`transition-all duration-200 print:ml-0 ${sidebarCollapsed ? "ml-16" : "ml-60"}`}>
        <FilterBar
          accounts={accounts}
          zones={zones}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className="p-6">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
