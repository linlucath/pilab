import { useEffect, useRef, useState } from "react";
import { Archive, BookOpen, Bug, Check, ChevronDown, Moon, PanelRight, PanelRightClose, PanelLeftOpen, Sparkles, Sun, Wrench } from "lucide-react";
import type { PiLiveSession } from "../../shared/pi-sync";
import type { Session } from "../workspace-store";
import { folderName } from "../utils/session";

type DebugPanel = "request" | "history" | "diagnostics";
type Props = {
  session: Session; saveState: "saved" | "saving" | "error"; onDebugView: (view: DebugPanel) => void;
  sidebarCollapsed: boolean; onOpenSidebar: () => void; theme: "light" | "dark"; onTheme: () => void;
  rightOpen: boolean; onRight: () => void; compactTools: boolean; onCompactTools: () => void;
  piSessions: PiLiveSession[]; followPi: boolean; onFollowPi: (value: boolean) => void;
  syncError: string; onSelectPi: (id: string) => void; onApplyPi: () => void; onDiscardPi: () => void; onCancelPending: () => void;
  onTitle: (value: string) => void; onWorkingDirectory: (value: string) => void;
  onFork: () => void; forkDisabled?: boolean;
  directoryOpen?: boolean; onDirectoryToggle?: () => void;
  archiveableToolGroups?: number; onArchiveOldTools?: () => void;
};

export function TopBar(props: Props) {
  const [editingCwd, setEditingCwd] = useState(false);
  const debugMenu = useRef<HTMLDetailsElement>(null);
  const [cwd, setCwd] = useState(props.session.settings.workingDirectory);
  useEffect(() => setCwd(props.session.settings.workingDirectory), [props.session.id, props.session.settings.workingDirectory]);
  const currentPi = props.piSessions.find((entry) => entry.id === props.session.piSync?.id);
  const onlineCount = props.piSessions.filter((entry) => entry.online).length;
  const saveLabel = props.saveState === "saving" ? "保存中" : props.saveState === "error" ? "保存失败" : "已保存";
  const workingDirectory = props.session.settings.workingDirectory;
  const openDebug = (view: DebugPanel) => {
    props.onDebugView(view);
    debugMenu.current?.removeAttribute("open");
  };
  return <header className="topbar">
    <div className="topbar-leading">
      {props.sidebarCollapsed && <button className="icon-button" onClick={props.onOpenSidebar} aria-label="展开会话栏" title="展开会话栏"><PanelLeftOpen size={17} /></button>}
      <div className="title-line"><Sparkles size={16} /><input aria-label="会话标题" value={props.session.title} maxLength={200} onChange={(event) => props.onTitle(event.target.value)} /></div>
      <div className="cwd-control">
        {editingCwd ? <input autoFocus aria-label="工作目录" value={cwd} onChange={(event) => setCwd(event.target.value)} onBlur={() => { props.onWorkingDirectory(cwd); setEditingCwd(false); }} onKeyDown={(event) => { if (event.key === "Enter") { props.onWorkingDirectory(cwd); setEditingCwd(false); } if (event.key === "Escape") { setCwd(workingDirectory); setEditingCwd(false); } }} /> : <button title={workingDirectory || "服务端默认目录"} aria-label={`编辑工作目录：${workingDirectory || "服务端默认目录"}`} onClick={() => setEditingCwd(true)}>📁 <span>{folderName(workingDirectory)}</span></button>}
      </div>
      <span className={`save-state ${props.saveState}`}><span />{saveLabel}</span>
    </div>
    <div className="topbar-trailing">
      <button type="button" className={`topbar-directory-button ${props.directoryOpen ? "active" : ""}`} aria-label="目录与搜索" aria-expanded={!!props.directoryOpen} title="打开对话目录与搜索 · ⌘F / Ctrl+F" onClick={props.onDirectoryToggle}><BookOpen size={14} /><span>目录</span></button>
      {(props.archiveableToolGroups || 0) > 0 && <button type="button" className="topbar-archive-button" disabled={props.forkDisabled} onClick={props.onArchiveOldTools} title={`精简 ${props.archiveableToolGroups} 个较旧的工具组`} aria-label={`精简 ${props.archiveableToolGroups} 个较旧的工具组`}><Archive size={14} /><span>{props.archiveableToolGroups}</span></button>}
      <button className={`tool-fold-button ${props.compactTools ? "active" : ""}`} onClick={props.onCompactTools} title={props.compactTools ? "展开工具过程" : "收起工具过程"} aria-label={props.compactTools ? "展开工具" : "收起工具"}><Wrench size={15} /><span>{props.compactTools ? "展开工具" : "收起工具"}</span></button>
      <button className="fork-topbar-button" disabled={props.forkDisabled} onClick={props.onFork} title="创建一个携带提纯记忆的新会话分身"><Sparkles size={14} /><span>提纯分身</span></button>
      <details className="pi-sync-menu">
        <summary className={`pi-sync-pill ${currentPi?.online ? "online" : ""}`} title={currentPi ? `${currentPi.name} · ${currentPi.online ? "在线" : "离线"}` : "Pi 同步"}><span className="pi-status-dot" /><span>Pi 同步</span><ChevronDown size={14} /></summary>
        <div className="pi-sync-popover">
          <div className="popover-heading"><strong>Pi CLI 同步</strong><small>{onlineCount} 个在线</small></div>
          <select aria-label="选择 Pi CLI 会话" value={props.session.piSync?.id || ""} onChange={(event) => event.target.value && props.onSelectPi(event.target.value)}><option value="">选择 Pi 会话…</option>{props.piSessions.map((item) => <option key={item.id} value={item.id}>{item.online ? "●" : "○"} {item.name} · {item.cwd.split(/[\\/]/).at(-1)}</option>)}</select>
          <label className="follow-toggle"><input type="checkbox" checked={props.followPi} onChange={(event) => props.onFollowPi(event.target.checked)} />跟随最新活跃会话</label>
          {props.syncError && <p className="inline-error">{props.syncError}</p>}
          {props.session.piSync && <>
            <div className="sync-status-copy">{props.session.piSync.pending ? "等待 Pi 确认应用…" : props.session.piSync.dirty ? "本地消息有修改，尚未应用到 Pi" : currentPi?.online ? currentPi.busy ? "Pi 正在执行" : "实时同步中" : "Pi 会话离线"}</div>
            {props.session.piSync.pending && <button className="link-button" onClick={props.onCancelPending}>保留草稿并解除等待</button>}
            {props.session.piSync.dirty && <div className="sync-actions"><button onClick={props.onDiscardPi}>放弃修改</button><button className="solid-small" disabled={!currentPi?.online || currentPi.busy || !!props.session.piSync.pending} onClick={props.onApplyPi}><Check size={13} />应用到 Pi</button></div>}
          </>}
          <div className="popover-footnote">选择会话可导入或继续同步其上下文</div>
        </div>
      </details>
      <details className="debug-menu" ref={debugMenu}>
        <summary className="icon-button" aria-label="打开调试工具" title="调试工具"><Bug size={16} /></summary>
        <div className="debug-popover" aria-label="调试工具">
          <strong>调试工具</strong>
          <button onClick={() => openDebug("request")}>请求检查</button>
          <button onClick={() => openDebug("history")}>运行记录</button>
          <button onClick={() => openDebug("diagnostics")}>诊断日志</button>
        </div>
      </details>
      <button className="icon-button theme-button" aria-label={props.theme === "light" ? "切换深色模式" : "切换浅色模式"} title={props.theme === "light" ? "切换深色模式" : "切换浅色模式"} onClick={props.onTheme}>{props.theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
      <button className={`icon-button right-toggle ${props.rightOpen ? "active" : ""}`} aria-label={props.rightOpen ? "隐藏工作台" : "显示工作台"} title={props.rightOpen ? "隐藏工作台" : "显示工作台"} onClick={props.onRight}>{props.rightOpen ? <PanelRightClose size={17} /> : <PanelRight size={17} />}</button>
    </div>
  </header>;
}
