"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { APP_CONFIG, GITHUB_CONFIG } from "@/shared/constants/config";
import DonateModal from "./DonateModal";

// 9Router Pro welcome popup — shown once on first dashboard open.
// The "seen" flag lives in DashboardLayout (localStorage), this modal is
// a dumb presentational shell like DonateModal: isOpen + onClose.
export const WELCOME_STORAGE_KEY = "9router-pro-welcome-v1";
export const TELEGRAM_URL = "https://t.me/Gieneticc";

const THANKS_TO = [
  "Allah SWT",
  "KRYZEN TEAM",
  "Komunitas Telegram",
  "decolua — pembuat 9Router original",
  "dan kamu, para pengguna setia 9Router Pro",
];

export default function WelcomeModal({ isOpen, onClose }) {
  const [donateOpen, setDonateOpen] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        className="relative w-full max-w-md bg-surface border border-black/10 dark:border-white/10 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh] overflow-hidden"
      >
        {/* Header — Pro logo + name */}
        <div className="flex flex-col items-center pt-7 pb-2 px-6 text-center">
          <img
            src="/logo-pro-v3.png"
            alt="9Router Pro"
            className="size-16 rounded-2xl shadow-lg"
          />
          <h2 className="mt-3 text-xl font-bold text-text-main">
            9Router <span className="bg-gradient-to-r from-violet-500 to-pink-500 bg-clip-text text-transparent">Pro</span>
          </h2>
          <p className="mt-0.5 text-xs font-semibold tracking-widest text-text-muted uppercase">
            Mod Edition &middot; v{APP_CONFIG.version}
          </p>
        </div>

        <div className="px-6 pb-6 overflow-y-auto flex-1">
          <p className="text-sm text-text-main text-center leading-relaxed">
            Terima kasih telah menggunakan <strong>9Router Pro</strong> &mdash; Mod
            Edition, powered by <strong>Gienetic</strong>.
          </p>
          <p className="mt-3 text-sm text-text-muted text-center leading-relaxed">
            Satu pintu untuk semua model AI, semua provider, dan semua API key kamu
            &mdash; dirancang supaya kerja kamu lebih ringan, lebih cepat, dan lebih
            optimal.
          </p>
          <p className="mt-3 text-sm text-text-muted text-center leading-relaxed">
            Saran dan laporan kamu sangat berarti. Kenyamanan kamu saat memakai
            9Router Pro adalah prioritas &mdash; kalau ada yang kurang pas, jangan
            ragu untuk melapor.
          </p>
          <p className="mt-3 text-sm text-text-muted text-center leading-relaxed">
            Bantu kami berkembang: beri <strong className="text-text-main">&#9733; Star di
            GitHub</strong> dan bagikan 9Router Pro ke grup, komunitas, dan
            teman-teman kamu &mdash; supaya mereka juga punya router AI yang
            mempermudah kerja mereka.
          </p>
          <p className="mt-3 text-sm text-text-main text-center leading-relaxed">
            Saya akan terus meningkatkan 9Router Pro semaksimal mungkin, untuk
            pengalaman penggunaan yang lebih optimal.
          </p>

          {/* Thanks to */}
          <div className="mt-5 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 px-4 py-3">
            <p className="text-[11px] font-semibold tracking-widest text-text-muted uppercase text-center">
              Terima kasih kepada
            </p>
            <p className="mt-1.5 text-xs text-text-muted text-center leading-relaxed">
              {THANKS_TO.join(" \u00b7 ")}
            </p>
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-pink-500 hover:opacity-90 transition-opacity"
            >
              Mulai Menggunakan
            </button>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setDonateOpen(true)}
                className="inline-flex items-center justify-center gap-1 px-2 py-2 rounded-xl text-xs font-medium border border-black/10 dark:border-white/10 text-text-main hover:border-pink-500/40 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] text-pink-500">volunteer_activism</span>
                Donasi
              </button>
              <a
                href={TELEGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1 px-2 py-2 rounded-xl text-xs font-medium border border-black/10 dark:border-white/10 text-text-main hover:border-pink-500/40 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] text-sky-500">send</span>
                Telegram
              </a>
              <a
                href={GITHUB_CONFIG.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1 px-2 py-2 rounded-xl text-xs font-medium border border-black/10 dark:border-white/10 text-text-main hover:border-pink-500/40 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px] text-amber-500">star</span>
                Star GitHub
              </a>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          aria-label="Close"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>
      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
    </div>,
    document.body
  );
}

WelcomeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
