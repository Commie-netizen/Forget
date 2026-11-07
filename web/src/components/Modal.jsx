import React, { useEffect, useId, useRef, useState } from 'react';

// Accessible modal: role=dialog, aria-modal. Close with the X button, backdrop click, or Escape
// (listened for only while the modal is open; no focus trap).
export function Modal({ open, title, onClose, children, footer, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const node = ref.current;
    (node?.querySelector('[data-autofocus]') || node)?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id={titleId} className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Explicit confirmation. If `requireText` is provided, the user must enter it
 * to enable the confirmation button.
 */
export function Confirm({ open, title, children, confirmLabel = "Confirm", danger = false, requireText, busy = false, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (open) {
      setTyped('');
      setAck(false);
    }
  }, [open]);
  const ok = ack && (!requireText || typed.trim() === requireText);
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" data-autofocus onClick={onCancel}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} disabled={!ok || busy} onClick={onConfirm}>
            {busy ? "Starting..." : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      <label className="check confirm-ack">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand this action is irreversible and confirm it.</span>
      </label>
      {requireText && (
        <label className="field">
          <span className="field-label">Type "{requireText}" to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}
    </Modal>
  );
}
