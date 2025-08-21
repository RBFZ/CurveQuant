import React, { useState } from "react";

type Props = {
  title: string;
  defaultOpen?: boolean;
  id?: string;
  className?: string;
  children?: React.ReactNode;
};

/**
 * Simple accessible collapsible section.
 * - defaultOpen: controls initial open state (defaults to false)
 * - id: optional id for the body (useful if desired)
 * - rotates the arrow when open
 */
export default function CollapsibleSection({ title, defaultOpen = false, id, className, children }: Props) {
  const [open, setOpen] = useState<boolean>(defaultOpen);

  return (
    <div className={`collapsible ${className ?? ""}`}>
      <button
        type="button"
        className="collapsible-header"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`collapsible-arrow ${open ? "open" : ""}`}>{">"}</span>
        <span className="collapsible-title">{title}</span>
      </button>
      <div id={id} className={`collapsible-body ${open ? "open" : "closed"}`} aria-hidden={!open} style={{ display: open ? undefined : "none" }}>
        {children}
      </div>
    </div>
  );
}
