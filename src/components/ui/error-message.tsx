"use client";

import { AlertCircle, ShieldAlert, Clock, WifiOff } from "lucide-react";

interface ErrorMessageProps {
  type?: "permission" | "rate_limit" | "network" | "empty" | "generic";
  message?: string;
  retryAfter?: number;
  onRetry?: () => void;
}

const icons = {
  permission: <ShieldAlert size={20} />,
  rate_limit: <Clock size={20} />,
  network: <WifiOff size={20} />,
  empty: <AlertCircle size={20} />,
  generic: <AlertCircle size={20} />,
};

const defaultMessages = {
  permission: "Your API token doesn't have the required permissions for this report.",
  rate_limit: "Rate limit exceeded. Retrying automatically...",
  network: "Unable to connect to the Cloudflare API. Check your connection.",
  empty: "No data found for the selected time range. Try expanding the date range.",
  generic: "Something went wrong.",
};

export default function ErrorMessage({ type = "generic", message, retryAfter, onRetry }: ErrorMessageProps) {
  const borderColor = type === "permission" ? "border-yellow-500/20" : "border-red-500/20";
  const bgColor = type === "permission" ? "bg-yellow-500/10" : "bg-red-500/10";
  const textColor = type === "permission" ? "text-yellow-400" : "text-red-400";
  const iconColor = type === "permission" ? "text-yellow-500" : "text-red-500";

  return (
    <div className={`flex items-start gap-3 rounded-lg border ${borderColor} ${bgColor} p-4`}>
      <div className={`mt-0.5 shrink-0 ${iconColor}`}>{icons[type]}</div>
      <div className="flex-1">
        <p className={`text-sm ${textColor}`}>{message || defaultMessages[type]}</p>
        {retryAfter !== undefined && (
          <p className="mt-1 text-xs text-zinc-500">Retrying in {retryAfter}s...</p>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 text-xs font-medium text-orange-400 hover:text-orange-300"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
