import type { KeyboardEvent, ReactNode } from "react";

/** Modal shell: Escape cancels and Tab focus wraps inside the dialog. */
export function Modal({
  role = "dialog",
  labelledBy,
  onCancel,
  children,
}: {
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)",
        ),
      );
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      focusable[
        (index + (event.shiftKey ? -1 : 1) + focusable.length) %
          focusable.length
      ]?.focus();
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal panel"
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
      >
        {children}
      </section>
    </div>
  );
}
