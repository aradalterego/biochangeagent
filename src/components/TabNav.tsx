"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Horizontal tabs for a section with several pages. The first tab is active only on its exact path. */
export function TabNav({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 border-b border-line text-sm">
      {tabs.map((t, i) => {
        const active = i === 0 ? path === t.href || (path.startsWith(`${t.href}/`) && !tabs.slice(1).some((o) => path.startsWith(o.href))) : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={`-mb-px border-b-2 px-3 py-2 ${active ? "border-brand font-medium text-brand-dark" : "border-transparent text-muted hover:text-ink"}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
