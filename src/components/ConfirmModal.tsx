import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

type Props = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmModal({ title, description, confirmLabel, cancelLabel = "取消", variant = "default", onClose, onConfirm }: Props) {
  const [pending, setPending] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const close = () => {
    if (!pending) onClose();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])];
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !dialogRef.current?.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !dialogRef.current?.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  };
  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setPending(false);
    }
  };

  return createPortal(<div className="confirm-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-description" onKeyDown={handleKeyDown}>
      <div className={`confirm-modal-mark ${variant}`} aria-hidden="true">!</div>
      <div className="confirm-modal-copy">
        <h2 id="confirm-modal-title">{title}</h2>
        <p id="confirm-modal-description">{description}</p>
      </div>
      <footer className="confirm-modal-actions">
        <button ref={cancelButtonRef} type="button" className="confirm-modal-cancel" disabled={pending} onClick={close}>{cancelLabel}</button>
        <button type="button" className={`confirm-modal-confirm ${variant}`} disabled={pending} onClick={() => void handleConfirm()}>{pending ? "处理中…" : confirmLabel}</button>
      </footer>
    </section>
  </div>, document.body);
}
