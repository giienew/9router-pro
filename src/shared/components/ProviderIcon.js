"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getBrandIconSrc, getFaviconCandidates, getNameIconSrc, getProviderIconSrc, getTypeBrandIconSrc, markFaviconMissing, markProviderIconMissing } from "@/shared/utils/providerIcon";

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
  providerType,
}) {
  // Icon chain: the bundled /providers/{id}.png first, then the bundled
  // mark matching the provider's display name (alt, e.g. tokenharbor),
  // then — for custom providers whose API base URL is a known brand
  // host — that brand's bundled mark, then the site's own
  // apple-touch-icon (origin, then parent domain), then favicon.ico,
  // then — only for custom nodes with no icon of their own — the API
  // type's main brand mark (openai-compatible → openai,
  // anthropic-compatible → anthropic), then the initials fallback.
  // The type mark is LAST by design: it never overrides a provider's
  // own icon. Purely presentational: plain <img> loads,
  // browser-cached, and a failed candidate is never retried this
  // session.
  const localSrc = resolveSrc(src, providerId);
  const nameSrc = getNameIconSrc(alt);
  const brandSrc = getBrandIconSrc(detectBaseUrl);
  const typeSrc = getTypeBrandIconSrc(providerType);
  const candidates = [];
  const pushUnique = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  pushUnique(localSrc);
  pushUnique(nameSrc);
  pushUnique(brandSrc);
  for (const candidate of getFaviconCandidates(detectBaseUrl)) pushUnique(candidate);
  pushUnique(typeSrc);
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
  providerType: PropTypes.string,
};
