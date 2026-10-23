"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getFaviconCandidates, getProviderIconSrc, markFaviconMissing, markProviderIconMissing } from "@/shared/utils/providerIcon";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.png$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
  detectBaseUrl,
}) {
  // Icon chain: the bundled /providers/{id}.png first, then — for
  // custom providers that pass their API base URL — the site's own
  // favicon (origin, then parent domain), then the initials fallback.
  // Purely presentational: plain <img> loads, browser-cached, and a
  // failed candidate is never retried this session.
  const localSrc = resolveSrc(src, providerId);
  const candidates = [
    ...(localSrc ? [localSrc] : []),
    ...getFaviconCandidates(detectBaseUrl),
  ];
  const [attempt, setAttempt] = useState(0);
  const current = candidates[attempt];

  if (!current) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={current}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        const m = current.match(/^\/providers\/([^/]+)\.png$/i);
        if (m) {
          markProviderIconMissing(m[1]);
          if (providerId) markProviderIconMissing(providerId);
        } else {
          markFaviconMissing(current);
        }
        setAttempt((a) => a + 1);
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
  detectBaseUrl: PropTypes.string,
};
