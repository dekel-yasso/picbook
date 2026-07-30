import type { Metadata, Viewport } from "next";
import { Archivo, Heebo } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { SWRegister } from "./sw-register";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});

const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew"],
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "PicBook",
  description:
    "Cull, organize, and book your travel photos — entirely on your device.",
  appleWebApp: {
    capable: true,
    title: "PicBook",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#f3f2f2",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${heebo.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <I18nProvider>{children}</I18nProvider>
        <SWRegister />
      </body>
    </html>
  );
}
