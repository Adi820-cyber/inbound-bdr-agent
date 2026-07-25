import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inbound BDR Agent",
  description:
    "Six-stage autonomous pipeline that turns one inbound contact-form email into a qualification, live-sourced research, an email sequence, a case-study match, a GTM motion, and an AE handoff.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
