import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, IBM_Plex_Sans, Source_Sans_3 } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
import { cn } from "@/lib/utils";

const sourceSans3Heading = Source_Sans_3({subsets:['latin'],variable:'--font-heading'});

const ibmPlexSans = IBM_Plex_Sans({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MEOW",
  description: "MEOW for e-commerce",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.svg",
  },
};

// Sin script de bloqueo inline: React/Next 16 avisa en consola ante CUALQUIER
// `<script>` (crudo o vía `next/script`) renderizado por un componente, así
// que el tema se aplica en el cliente al montar (ThemeProvider). El primer
// pintado usa el tema por defecto; el parpadeo posible se asume a cambio de
// cero errores en consola.

// Layout raíz mínimo: solo tema. El chrome del dashboard (sidebar/header)
// vive en app/(dashboard)/layout.tsx; /login queda totalmente independiente.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", ibmPlexSans.variable, sourceSans3Heading.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
