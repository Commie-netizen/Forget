import React, { useEffect, useId, useRef, useState } from 'react';

// Modale accessible : role=dialog, aria-modal. Fermeture : bouton croix, clic sur le fond ou Échap
// (écouté uniquement tant que la modale est ouverte, aucun piège de focus).
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
        <button type="button" className="modal-close" aria-label="Fermer" onClick={onClose}>×</button>
        <h2 id={titleId} className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation explicite. Si `requireText` est fourni, l'utilisateur doit le saisir
 * pour activer le bouton de confirmation.
 */
export function Confirm({ open, title, children, confirmLabel = 'Confirmer', danger = false, requireText, busy = false, onConfirm, onCancel }) {
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
          <button type="button" className="btn" data-autofocus onClick={onCancel}>Annuler</button>
          <button type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} disabled={!ok || busy} onClick={onConfirm}>
            {busy ? 'Lancement...' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      <label className="check confirm-ack">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>Je comprends que cette action est irréversible et je la confirme.</span>
      </label>
      {requireText && (
        <label className="field">
          <span className="field-label">Saisissez « {requireText} » pour confirmer</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}
    </Modal>
  );
}
