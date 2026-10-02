import Link from "next/link";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={`mx-auto px-6 py-8 ${wide ? "max-w-7xl" : "max-w-5xl"}`}>{children}</div>;
}

const TONES = {
  neutral: "bg-canvas text-muted",
  brand: "bg-brand-soft text-brand-dark",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof TONES; children: React.ReactNode }) {
  return <span className={`badge ${TONES[tone]}`}>{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card mb-5 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="h2">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="text-sm">{children ?? "—"}</div>
    </div>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: React.ReactNode; variant?: "primary" | "secondary" }) {
  return <Link href={href} className={variant === "primary" ? "btn-primary" : "btn-secondary"}>{children}</Link>;
}

export function statusTone(status: string): keyof typeof TONES {
  if (["approved", "completed", "received", "followed_up", "answered", "resolved"].includes(status)) return "ok";
  if (["pending_review", "draft", "follow_up_due", "new", "in_review", "scheduled", "submitted", "open"].includes(status)) return "warn";
  if (["revoked", "cancelled", "failed", "urgent"].includes(status)) return "danger";
  if (["treated", "planned", "confirmed", "shipped"].includes(status)) return "brand";
  return "neutral";
}
