import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { GptSessionSummary } from "../../shared/gpt-sessions";
import { filterClosedWorkerTabs, sortWorkerTabs } from "../utils/worker-tabs";

type Props = {
  sessionId: string;
  workers: GptSessionSummary[];
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  onCloseWorker: (id: string) => void;
};

export function ThreadTabs({ sessionId, workers, selectedWorkerId, onSelectWorker, onCloseWorker }: Props) {
  const [closedTabs, setClosedTabs] = useState<{ sessionId: string; ids: Set<string> }>(() => ({ sessionId, ids: new Set() }));
  const visibleWorkers = useMemo(() => {
    const closedTabIds = closedTabs.sessionId === sessionId ? closedTabs.ids : new Set<string>();
    return sortWorkerTabs(filterClosedWorkerTabs(workers, closedTabIds));
  }, [workers, closedTabs, sessionId]);

  const closeTab = (workerId: string) => {
    setClosedTabs((current) => {
      const ids = current.sessionId === sessionId ? current.ids : new Set<string>();
      return { sessionId, ids: new Set(ids).add(workerId) };
    });
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
          {(worker.status === "waiting_input" || (worker.pendingQuestionCount ?? 0) > 0) && worker.status !== "running"
            ? <span className="thread-waiting-dot" aria-label="等待输入" />
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
