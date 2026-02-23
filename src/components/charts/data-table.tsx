"use client";

interface Column<T> {
  key: string;
  label: string;
  render?: (value: unknown, row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  maxRows?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function DataTable<T extends Record<string, any>>({
  columns,
  data,
  maxRows,
}: DataTableProps<T>) {
  const displayData = maxRows ? data.slice(0, maxRows) : data;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-2 text-xs font-medium uppercase tracking-wider text-zinc-500 ${
                  col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                }`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.label}
              </th>
            ))}
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
                No data available
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {maxRows && data.length > maxRows && (
        <p className="mt-2 text-xs text-zinc-600">
          Showing top {maxRows} of {data.length} results
        </p>
      )}
    </div>
  );
}
