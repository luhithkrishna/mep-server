export const metadata = {
  title: "MCP Server — Textile Ledger",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body
        className="bg-slate-950 text-white min-h-screen antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}