"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/enroll", label: "Enroll" },
  { href: "/schedule", label: "Schedule" },
  { href: "/grades", label: "Grades" },
  { href: "/documents", label: "Documents" },
  { href: "/holds", label: "Holds" },
  { href: "/account", label: "Account" },
];

export function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav aria-label="Portal" className="flex flex-wrap gap-x-4 gap-y-1 text-body">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={isActive(link.href) ? "page" : undefined}
          className={
            isActive(link.href)
              ? "font-semibold text-ink underline decoration-signal decoration-2 underline-offset-4"
              : "text-ink-soft hover:text-ink"
          }
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
