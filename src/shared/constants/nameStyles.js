// 9Router Pro — display-name styles for the personal name in the header.
// The name is a small personal touch ("pemikat"): accent-colored text in
// place of the old theme/accent icon buttons, click to customize.
// Fonts are loaded once in app/layout.js (Inter + Space Grotesk +
// Playfair Display + Pacifico) and referenced via their CSS variables;
// mono / caps / italic reuse stacks that cost nothing extra.
export const DEFAULT_NAME = "Gienetic";

export const NAME_FONTS = [
  { id: "modern", name: "Modern", style: { fontFamily: "var(--font-inter)", fontWeight: 600 } },
  { id: "grotesk", name: "Grotesk", style: { fontFamily: "var(--font-grotesk)", fontWeight: 600 } },
  { id: "serif", name: "Serif", style: { fontFamily: "var(--font-playfair)", fontWeight: 600 } },
  { id: "script", name: "Script", style: { fontFamily: "var(--font-pacifico)", fontWeight: 400, fontSize: "1.15em" } },
  { id: "mono", name: "Mono", style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 600 } },
  { id: "caps", name: "Bold Caps", style: { fontFamily: "var(--font-inter)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" } },
  { id: "italic", name: "Italic", style: { fontFamily: "var(--font-inter)", fontWeight: 500, fontStyle: "italic" } },
];

export function isValidNameFont(id) {
  return NAME_FONTS.some((f) => f.id === id);
}

export function getNameFontStyle(id) {
  return (NAME_FONTS.find((f) => f.id === id) || NAME_FONTS[0]).style;
}
