"use client";

import { ReactNode } from "react";
import { ChartSkeleton } from "@/components/ui/skeleton";
import ErrorMessage from "@/components/ui/error-message";

interface ChartWrapperProps {
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  errorType?: "permission" | "rate_limit" | "network" | "empty" | "generic";
  onRetry?: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}

export default function ChartWrapper({
  title,
  subtitle,
  loading,
  error,
  errorType,
  onRetry,
  children,
  className = "",
  actions,
}: ChartWrapperProps) {
  if (loading) return <ChartSkeleton />;

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {error ? (
        <ErrorMessage type={errorType} message={error} onRetry={onRetry} />
      ) : (
        children
      )}
    </div>
  );
}
