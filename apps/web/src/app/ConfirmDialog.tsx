import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * A modal question with a safe default. Native <dialog>: focus is trapped, Escape cancels,
 * and focus returns to the control that opened it. The cancelling button is focused first,
 * so a stray Enter never destroys anything.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  // A page can hold more than one of these, so each names itself with its own id.
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      keep.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="confirm" onClose={onCancel} aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <div className="confirm-body">{children}</div>
      <div className="confirm-actions">
        <button ref={keep} type="button" className="btn brass" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="btn" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
