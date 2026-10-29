import { PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import type { Session } from "../workspace-store";

type Props = {
  session: Session;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onTitle: (value: string) => void;
};

export function TopBar({ session, sidebarCollapsed, onToggleSidebar, onTitle }: Props) {
  return <header className="topbar">
    <div className="topbar-leading">
      <button className="icon-button sidebar-top-toggle sidebar-mobile-toggle" onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "展开会话栏 / 展开侧栏" : "收起会话栏 / 收起侧栏"}
        title={sidebarCollapsed ? "展开会话栏" : "收起会话栏"}>
        {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
      <div className="title-line"><Sparkles size={16} /><input aria-label="会话标题" value={session.title} maxLength={200} onChange={(event) => onTitle(event.target.value)} /></div>
    </div>
  </header>;
}
