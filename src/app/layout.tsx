import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BioChange Vet Companion",
  description: "Clinical, product and adoption companion for BioChange veterinary regenerative dentistry.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
