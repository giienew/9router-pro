// 9Router Pro — display-name styles for the personal name in the header.
// The name is a small personal touch ("pemikat"): accent-colored text in
// place of the old theme/accent icon buttons, click to customize.
// All fonts are loaded once in app/layout.js via next/font (self-hosted)
// and referenced through their CSS variables; caps/italic reuse Inter.
// fontSize tweaks keep the display faces at a similar visual size —
// script and pixel faces render much smaller/larger than plain sans.
export const DEFAULT_NAME = "Gienetic";

export const NAME_FONTS = [
  // Sans
  { id: "modern", name: "Modern", group: "Sans", style: { fontFamily: "var(--font-inter)", fontWeight: 600 } },
  { id: "grotesk", name: "Grotesk", group: "Sans", style: { fontFamily: "var(--font-grotesk)", fontWeight: 600 } },
  { id: "poppins", name: "Poppins", group: "Sans", style: { fontFamily: "var(--font-poppins)", fontWeight: 600 } },
  { id: "montserrat", name: "Montserrat", group: "Sans", style: { fontFamily: "var(--font-montserrat)", fontWeight: 700 } },
  { id: "caps", name: "Bold Caps", group: "Sans", style: { fontFamily: "var(--font-inter)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" } },
  { id: "italic", name: "Italic", group: "Sans", style: { fontFamily: "var(--font-inter)", fontWeight: 500, fontStyle: "italic" } },
  // Display
  { id: "bebas", name: "Bebas", group: "Display", style: { fontFamily: "var(--font-bebas)", fontWeight: 400, fontSize: "1.18em", letterSpacing: "0.04em" } },
  { id: "anton", name: "Anton", group: "Display", style: { fontFamily: "var(--font-anton)", fontWeight: 400, fontSize: "1.05em", letterSpacing: "0.02em" } },
  { id: "orbitron", name: "Techno", group: "Display", style: { fontFamily: "var(--font-orbitron)", fontWeight: 600, fontSize: "0.92em", letterSpacing: "0.05em" } },
  { id: "lobster", name: "Retro", group: "Display", style: { fontFamily: "var(--font-lobster)", fontWeight: 400, fontSize: "1.08em" } },
  { id: "bangers", name: "Comic", group: "Display", style: { fontFamily: "var(--font-bangers)", fontWeight: 400, fontSize: "1.12em", letterSpacing: "0.04em" } },
  // Serif
  { id: "serif", name: "Serif", group: "Serif", style: { fontFamily: "var(--font-playfair)", fontWeight: 600 } },
  { id: "slab", name: "Slab", group: "Serif", style: { fontFamily: "var(--font-zilla)", fontWeight: 600 } },
  // Script & handwriting
  { id: "script", name: "Script", group: "Script", style: { fontFamily: "var(--font-pacifico)", fontWeight: 400, fontSize: "1.12em" } },
  { id: "vibes", name: "Kaligrafi", group: "Script", style: { fontFamily: "var(--font-vibes)", fontWeight: 400, fontSize: "1.38em" } },
  { id: "caveat", name: "Handwriting", group: "Script", style: { fontFamily: "var(--font-caveat)", fontWeight: 600, fontSize: "1.28em" } },
  // Mono & fun
  { id: "mono", name: "Mono", group: "Mono & Fun", style: { fontFamily: "var(--font-jetbrains)", fontWeight: 600 } },
  { id: "typewriter", name: "Typewriter", group: "Mono & Fun", style: { fontFamily: "var(--font-special)", fontWeight: 400 } },
  { id: "pixel", name: "Pixel", group: "Mono & Fun", style: { fontFamily: "var(--font-pixel)", fontWeight: 400, fontSize: "0.58em" } },
];

export function isValidNameFont(id) {
  return NAME_FONTS.some((f) => f.id === id);
}

export function getNameFontStyle(id) {
  return (NAME_FONTS.find((f) => f.id === id) || NAME_FONTS[0]).style;
}
