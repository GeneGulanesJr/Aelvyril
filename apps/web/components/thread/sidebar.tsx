"use client";
import type { Thread, ThreadStatus } from "@aelvyril/shared";

const STATUS_COLORS: Record<ThreadStatus, string> = {
  draft: "bg-[#2b3245] text-[#8b96a8]",
  "spec'ing": "bg-[#e3b341]/20 text-[#e3b341]",
  running: "bg-[#1f6feb]/20 text-[#1f6feb]",
  reviewed: "bg-[#3fb950]/20 text-[#3fb950]",
  merged: "bg-[#3fb950]/10 text-[#3fb950]/60",
  abandoned: "bg-[#f85149]/20 text-[#f85149]",
};

export function ThreadSidebar({ threads, activeId, onSelect, onCreate }: {
  threads: Thread[]; activeId: string | null;
  onSelect: (id: string) => void; onCreate: () => void;
}) {
  return (
    <aside className="flex w-64 flex-col border-r border-[#2b3245] bg-[#0d1117] p-3 text-sm">
      <button
        className="mb-3 rounded border border-[#2b3245] bg-[#161b27] px-3 py-2 text-left hover:bg-[#21262d]"
        onClick={onCreate}
        data-testid="new-thread"
      >
        + New thread
      </button>
      <ul className="space-y-1">
        {threads.map((t) => (
          <li key={t.id}>
            <button
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${activeId === t.id ? "bg-[#21262d]" : "hover:bg-[#161b27]"}`}
              onClick={() => onSelect(t.id)}
              data-testid={`thread-${t.id}`}
            >
              <span className="truncate">{t.title ?? t.id}</span>
              <span data-testid="status-pill" className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${STATUS_COLORS[t.status]}`}>{t.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
