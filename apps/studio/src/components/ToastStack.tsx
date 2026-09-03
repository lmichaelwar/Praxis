import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

export interface ToastView {
  id: string;
  title: string;
  detail: string;
  tone: "info" | "success" | "warning";
}

interface ToastStackProps {
  toasts: ToastView[];
  onDismiss: (id: string) => void;
}

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
};

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = icons[toast.tone];
        return (
          <article className="toast" data-tone={toast.tone} key={toast.id}>
            <Icon size={17} />
            <div><strong>{toast.title}</strong><p>{toast.detail}</p></div>
            <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}><X size={14} /></button>
          </article>
        );
      })}
    </div>
  );
}
