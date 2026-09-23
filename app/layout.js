import "./globals.css";
import ServiceWorker from "./ServiceWorker";

export const metadata = {
  title: "Coordinator Attendance",
  description: "Field attendance tracking for Coordinators",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Attendance",
    statusBarStyle: "default",
  },
};

// One viewport tag (Next.js renders it). Fits the page to the phone's width.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#1A6BA3",
};

// Safety net: if a phone is in "desktop site" mode the browser ignores the
// viewport tag and lays the page out ~980px wide, making everything tiny.
// Detect that and zoom the page back to the phone's real width.
const desktopModeFix = `(function(){try{
  var sw=Math.min(screen.width||0,screen.height||0), iw=window.innerWidth;
  var touch=window.matchMedia&&window.matchMedia('(pointer:coarse)').matches;
  if(touch&&sw>0&&sw<700&&iw>sw*1.3){var z=(iw/sw).toFixed(3),d=document.documentElement;d.style.zoom=z;d.style.setProperty('--app-zoom',z);}
}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <script dangerouslySetInnerHTML={{ __html: desktopModeFix }} />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
