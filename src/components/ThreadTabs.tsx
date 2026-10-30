import { useState } from "react";
import { X } from "lucide-react";
import type { GptSessionSummary } from "../../shared/gpt-sessions";

type Props = {
  workers: GptSessionSummary[];
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  onCloseWorker: (id: string) => void;
};

export function ThreadTabs({ workers, selectedWorkerId, onSelectWorker, onCloseWorker }: Props) {
  const [closedTabIds, setClosedTabIds] = useState<Set<string>>(() => new Set());
  const visibleWorkers = workers.filter((worker) => !closedTabIds.has(worker.id));

  const closeTab = (workerId: string) => {
    setClosedTabIds((current) => new Set(current).add(workerId));
    onCloseWorker(workerId);
  };

  return <nav className="thread-tabs-bar" aria-label="对话标签">
    <div className="thread-tabs-track" role="tablist" aria-label="会话">
      <button
        role="tab"
        aria-selected={!selectedWorkerId}
        className={`thread-tab-option thread-main-tab ${!selectedWorkerId ? "selected" : ""}`}
        onClick={() => onSelectWorker("")}
      >
        💬 主会话 (Gemini)
      </button>
      {visibleWorkers.map((worker) => <div className={`thread-tab-option-wrap ${selectedWorkerId === worker.id ? "selected" : ""}`} key={worker.id}>
        <button
          role="tab"
          aria-selected={selectedWorkerId === worker.id}
          className={`thread-tab-option thread-worker-tab ${selectedWorkerId === worker.id ? "selected" : ""}`}
          title={`${worker.name} · ${worker.status}`}
          onClick={() => onSelectWorker(worker.id)}
        >
          {worker.status === "running" || worker.status === "starting"
            ? <span className="thread-running-dot" aria-label="运行中" />
            : null}
          <span>🤖 {worker.name}</span>
        </button>
        <button
          className="thread-tab-close"
          title={`关闭 ${worker.name} 标签，不停止工兵`}
          aria-label={`关闭工兵标签 ${worker.name}`}
          onClick={() => closeTab(worker.id)}
        ><X size={13} /></button>
      </div>)}
    </div>
  </nav>;
}
