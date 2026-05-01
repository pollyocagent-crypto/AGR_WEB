import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AGR HMI Cloud",
    template: "%s | AGR HMI Cloud",
  },
  description: "Remote access and monitoring for AGR irrigation controllers.",
  applicationName: "AGR HMI Cloud",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "AGR HMI",
  },
};

export const viewport: Viewport = {
  themeColor: "#16a34a",
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
