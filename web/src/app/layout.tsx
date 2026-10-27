import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import '@/components/valyro-ui/styles/index.css';
import "./globals.css";
import { ThemeProvider } from '@/components/valyro-ui/theme/ThemeProvider';
import { Toaster } from '@/components/valyro-ui/feedback/Toaster';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Hearthstone Asset Studio",
  description: "Просмотр и экспорт ресурсов клиента Hearthstone",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html data-theme="vercel" data-mode="dark" lang="ru" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <ThemeProvider theme="vercel" mode="dark" locale="ru-RU">
          {children}
          <Toaster position="bottom-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
