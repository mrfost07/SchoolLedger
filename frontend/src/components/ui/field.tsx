import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

export function Field({ label, hint, error, className = "", id, ...rest }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;

  return (
    <div className={className}>
      <label className="block text-label font-semibold" htmlFor={fieldId}>
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        className={`mt-1 w-full border bg-surface px-3 py-2 text-body ${
          error ? "border-stamp" : "border-ink"
        }`}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="mt-1 text-micro text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-label text-stamp">
          {error}
        </p>
      ) : null}
    </div>
  );
}
