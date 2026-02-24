"use client";

import { useState, useMemo } from "react";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface Column<T> {
  key: string;
  label: string;
  render?: (value: unknown, row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
  sortable?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  maxRows?: number;
  searchable?: boolean;
  sortable?: boolean;
  paginated?: boolean;
}

type SortDirection = "asc" | "desc" | null;

export default function DataTable<T extends Record<string, any>>({
  columns,
  data,
  maxRows = 15,
  searchable = true,
  sortable = true,
  paginated = true,
}: DataTableProps<T>) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [currentPage, setCurrentPage] = useState(0);

  // Reset page when search changes
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(0);
  };

  // Cycle sort: none → asc → desc → none
  const handleSort = (key: string) => {
    if (!sortable) return;
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection("asc");
    } else if (sortDirection === "asc") {
      setSortDirection("desc");
    } else {
      setSortKey(null);
      setSortDirection(null);
    }
    setCurrentPage(0);
  };

  // Data pipeline: filter → sort → paginate
  const filteredData = useMemo(() => {
    if (!searchable || !searchQuery.trim()) return data;
    const q = searchQuery.toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const val = row[col.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
    );
  }, [data, searchQuery, searchable, columns]);

  const sortedData = useMemo(() => {
    if (!sortable || !sortKey || !sortDirection) return filteredData;
    return [...filteredData].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let cmp: number;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true, sensitivity: "base" });
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });
  }, [filteredData, sortKey, sortDirection, sortable]);

  const pageSize = maxRows;
  const totalPages = paginated ? Math.max(1, Math.ceil(sortedData.length / pageSize)) : 1;
  const displayData = paginated
    ? sortedData.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : sortedData;

  const showFrom = sortedData.length > 0 ? currentPage * pageSize + 1 : 0;
  const showTo = Math.min((currentPage + 1) * pageSize, sortedData.length);

  return (
    <div>
      {/* Search bar */}
      {searchable && data.length > 0 && (
        <div className="mb-3 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-1.5 pl-9 pr-3 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              {columns.map((col) => {
                const isSortable = sortable && col.sortable !== false;
                const isActive = sortKey === col.key && sortDirection;
                return (
                  <th
                    key={col.key}
                    className={`px-3 py-2 text-xs font-medium uppercase tracking-wider text-zinc-500 ${
                      col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                    } ${isSortable ? "cursor-pointer select-none hover:text-zinc-300" : ""}`}
                    style={col.width ? { width: col.width } : undefined}
                    onClick={() => isSortable && handleSort(col.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {isSortable && (
                        <span className="inline-flex text-zinc-600">
                          {isActive && sortDirection === "asc" ? (
                            <ChevronUp size={14} className="text-orange-400" />
                          ) : isActive && sortDirection === "desc" ? (
                            <ChevronDown size={14} className="text-orange-400" />
                          ) : (
                            <ChevronsUpDown size={14} />
                          )}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayData.map((row, i) => (
              <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 ${
                      col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                    } text-zinc-300`}
                  >
                    {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {displayData.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-zinc-500">
                  {searchQuery ? "No matching results" : "No data available"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {paginated && sortedData.length > pageSize && (
        <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
          <span>
            Showing {showFrom}–{showTo} of {sortedData.length}
            {filteredData.length !== data.length && ` (filtered from ${data.length})`}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(0)}
              disabled={currentPage === 0}
              className="rounded p-1 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsLeft size={14} />
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="rounded p-1 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2 text-zinc-400">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              className="rounded p-1 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight size={14} />
            </button>
            <button
              onClick={() => setCurrentPage(totalPages - 1)}
              disabled={currentPage >= totalPages - 1}
              className="rounded p-1 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
