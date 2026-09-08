import { X } from "lucide-react";
import { useId, useRef } from "react";
import { useOverlayKeyboard } from "../../hooks/useOverlayKeyboard";

export default function Modal({ open, onClose, title, children, width = "max-w-lg" }) {
  const titleId = useId();
  const panelRef = useRef(null);
  useOverlayKeyboard(panelRef, { activo: open, onCerrar: onClose });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-noche/50 p-4 py-10 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${width} rounded-lg border border-line bg-paper-50 shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 id={titleId} className="font-display text-base font-semibold text-ink-950">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-600 hover:bg-paper-200"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}
