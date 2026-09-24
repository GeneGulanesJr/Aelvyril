"use client";
export function PlanTab({ plan }: { plan: string[] }) {
  if (plan.length === 0) return <Empty text="No plan yet — ask something." />;
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="plan-list">
      {plan.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

export function TraceTab({ trace }: { trace: string[] }) {
  if (trace.length === 0) return <Empty text="No output yet." />;
  return (
    <div className="space-y-1 font-mono text-xs text-[#8b96a8]" data-testid="trace-list">
      {trace.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+")) return "text-[#3fb950]"; // added
  if (line.startsWith("-")) return "text-[#f85149]"; // removed
  if (line.startsWith("@@")) return "text-[#1f6feb]"; // hunk header
  return "text-[#8b96a8]"; // context
}

export function DiffTab({ diff }: { diff: { path: string; patch: string }[] }) {
  if (diff.length === 0) return <Empty text="No diff yet." />;
  return (
    <div className="space-y-2 text-xs" data-testid="diff-list">
      {diff.map((f) => (
        <details key={f.path} className="rounded border border-[#2b3245]">
          <summary className="cursor-pointer px-2 py-1 font-mono text-[#e6edf3]">{f.path}</summary>
          <pre className="overflow-x-auto p-2">
            {f.patch.split("\n").map((line, i) => (
              <div key={i} data-testid={`diff-line-${i}`} className={lineClass(line)}>{line}</div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-[#8b96a8]">{text}</p>;
}
