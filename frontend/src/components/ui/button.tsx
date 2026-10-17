import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-ink bg-signal text-ink hover:opacity-90",
  outline: "border border-ink bg-surface text-ink hover:bg-paper",
  ghost: "border border-transparent bg-transparent text-ink hover:bg-paper",
  danger: "border border-stamp bg-surface text-stamp hover:bg-stamp hover:text-surface",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-body",
  sm: "px-3 py-1.5 text-label",
};

export function buttonClasses(
  variant: ButtonVariant = "outline",
  size: ButtonSize = "md",
  className = "",
): string {
  return `inline-flex items-center justify-center gap-2 font-display font-semibold transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...rest} />;
}
