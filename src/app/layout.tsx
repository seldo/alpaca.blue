import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "alpaca.blue",
  description: "Your unified social timeline",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="/logomark.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}
