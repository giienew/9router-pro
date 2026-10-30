/**
 * Header Search Store — Zustand-based reusable search input in Header.
 * Pages register placeholder on mount, read query, unregister on unmount.
 */

import { create } from "zustand";

/**
 * The header search box is scoped to the Providers page only: it is the
 * single page that consumes the query (providers/page.js). Structural gate
 * in addition to register/unregister, so a stale `visible` state can never
 * render a dead search box on another page.
 */
export const HEADER_SEARCH_PATH = "/dashboard/providers";
export const isHeaderSearchPath = (pathname) => pathname === HEADER_SEARCH_PATH;

export const useHeaderSearchStore = create((set) => ({
  query: "",
  placeholder: "",
  visible: false,

  setQuery: (query) => set({ query }),

  register: (placeholder = "Search...") =>
    set({ visible: true, placeholder, query: "" }),

  unregister: () => set({ visible: false, placeholder: "", query: "" }),
}));
