import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Factory MIOS — Manufacturing Intelligence Operating System",
  description: "Connect machines, build KPIs, and run OEE dashboards across any industry.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
