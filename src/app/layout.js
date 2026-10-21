import { Inter, Space_Grotesk, Playfair_Display, Pacifico, Poppins, Montserrat, Bebas_Neue, Anton, Orbitron, Lobster, Bangers, Zilla_Slab, Great_Vibes, Caveat, JetBrains_Mono, Special_Elite, Press_Start_2P, Audiowide, Monoton, Rubik_Glitch, Michroma, VT323 } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// 9Router Pro: extra display fonts used ONLY by the header display name
// (see shared/constants/nameStyles.js). Self-hosted by next/font.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-grotesk",
});
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-playfair",
});
const pacifico = Pacifico({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-pacifico",
});
// The full display-name font set (see shared/constants/nameStyles.js).
const poppins = Poppins({ subsets: ["latin"], weight: ["600"], variable: "--font-poppins" });
const montserrat = Montserrat({ subsets: ["latin"], weight: ["700"], variable: "--font-montserrat" });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: ["400"], variable: "--font-bebas" });
const anton = Anton({ subsets: ["latin"], weight: ["400"], variable: "--font-anton" });
const orbitron = Orbitron({ subsets: ["latin"], weight: ["600"], variable: "--font-orbitron" });
const lobster = Lobster({ subsets: ["latin"], weight: ["400"], variable: "--font-lobster" });
const bangers = Bangers({ subsets: ["latin"], weight: ["400"], variable: "--font-bangers" });
const zilla = Zilla_Slab({ subsets: ["latin"], weight: ["600"], variable: "--font-zilla" });
const vibes = Great_Vibes({ subsets: ["latin"], weight: ["400"], variable: "--font-vibes" });
const caveat = Caveat({ subsets: ["latin"], weight: ["600"], variable: "--font-caveat" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["600"], variable: "--font-jetbrains" });
const special = Special_Elite({ subsets: ["latin"], weight: ["400"], variable: "--font-special" });
const pixel = Press_Start_2P({ subsets: ["latin"], weight: ["400"], variable: "--font-pixel" });
const audiowide = Audiowide({ subsets: ["latin"], weight: ["400"], variable: "--font-audiowide" });
const monoton = Monoton({ subsets: ["latin"], weight: ["400"], variable: "--font-monoton" });
const glitch = Rubik_Glitch({ subsets: ["latin"], weight: ["400"], variable: "--font-glitch" });
const michroma = Michroma({ subsets: ["latin"], weight: ["400"], variable: "--font-michroma" });
const vt323 = VT323({ subsets: ["latin"], weight: ["400"], variable: "--font-vt323" });

export const metadata = {
  title: "9Router Pro - AI Infrastructure Management",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (light) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'system';t=t||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
        {/* 9Router Pro: apply the saved accent before first paint (no flash). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var a=localStorage.getItem('9rp-accent');if(a==='custom'){var c=localStorage.getItem('9rp-accent-custom');document.documentElement.setAttribute('data-accent','custom');if(c&&/^#[0-9a-fA-F]{6}$/.test(c)){document.documentElement.style.setProperty('--color-brand-base',c)}}else if(a){if(a!=='coral'){document.documentElement.setAttribute('data-accent',a)}}else{document.documentElement.setAttribute('data-accent','violet')}}catch(e){}})();`,
          }}
        />
        {/* 9Router Pro: theme preset before first paint — Dark Pro is the
            default look; only an explicit "ori" choice opts out of it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem('9rp-preset');if(p!=='ori'){document.documentElement.setAttribute('data-preset','dark-pro');document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(f);setTimeout(f,3000)}else{f()}`,
          }}
        />
      </head>
      <body className={`${inter.variable} ${spaceGrotesk.variable} ${playfair.variable} ${pacifico.variable} ${poppins.variable} ${montserrat.variable} ${bebas.variable} ${anton.variable} ${orbitron.variable} ${lobster.variable} ${bangers.variable} ${zilla.variable} ${vibes.variable} ${caveat.variable} ${jetbrains.variable} ${special.variable} ${pixel.variable} ${audiowide.variable} ${monoton.variable} ${glitch.variable} ${michroma.variable} ${vt323.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
