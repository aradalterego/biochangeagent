"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children, subtle }: { href: string; children: React.ReactNode; subtle?: boolean }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`block truncate rounded-md px-2 py-1.5 ${active ? "bg-brand-soft font-medium text-brand-dark" : subtle ? "text-muted hover:bg-canvas" : "text-ink hover:bg-canvas"}`}
    >
      {children}
    </Link>
  );
}
