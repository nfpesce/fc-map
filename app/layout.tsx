import type { Metadata } from "next";
import packageJson from "../package.json";
import "./globals.css";

export const metadata: Metadata = {
  title: `Components Map · v${packageJson.version}`,
  description: "Interactive relationship map for PPN, SBB, FC, and Option. Data is processed locally in the browser.",
  robots: { index: false, follow: false },
};

/*
 * Content-Security-Policy: `connect-src 'self'` blocks any request to another
 * origin, so the page technically cannot send the local data anywhere.
 * Applied only to production builds (the dev server needs eval/websockets).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {process.env.NODE_ENV === "production" && <meta httpEquiv="Content-Security-Policy" content={CONTENT_SECURITY_POLICY} />}
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>{children}</body>
    </html>
  );
}
