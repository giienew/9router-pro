"use client";

import { useState } from "react";
import PropTypes from "prop-types";

// First-request snippet (G5). Renders curl + OpenAI-format examples against
// `{origin}/v1` and references the key only by NAME — the secret value is
// never rendered here. The caller passes baseUrl (already origin + /v1)
// and the key name to mention, if one is known.
export default function FirstRequestSnippet({ baseUrl, keyName }) {
  const [tab, setTab] = useState("curl");
  const [copied, setCopied] = useState(false);

  const endpoint = baseUrl || "/v1";
  const nameNote = keyName
    ? `# API key: ${keyName} — paste that key's value where YOUR_API_KEY appears below.`
    : `# Paste one of your API keys where YOUR_API_KEY appears below.`;
  const curl = `${nameNote}\ncurl ${endpoint}/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "auto:fast", "messages": [{"role": "user", "content": "Hello!"}]}'\n# auto:fast picks a connected model for you — or use any model id from /v1/models.`;
  const python = `${nameNote}\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${endpoint}", api_key="YOUR_API_KEY")\nresp = client.chat.completions.create(\n    model="auto:fast",  # or any model id from /v1/models\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(resp.choices[0].message.content)`;

  const text = tab === "curl" ? curl : python;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-text-main">Try your first request</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("curl")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${tab === "curl" ? "bg-primary text-white" : "text-text-muted hover:text-text-main"}`}
          >
            curl
          </button>
          <button
            type="button"
            onClick={() => setTab("python")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${tab === "python" ? "bg-primary text-white" : "text-text-muted hover:text-text-main"}`}
          >
            Python (OpenAI)
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="ml-1 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:opacity-80"
          >
            <span className="material-symbols-outlined text-[14px]">{copied ? "check" : "content_copy"}</span>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/5 p-3 font-mono text-xs text-text-main dark:bg-black/30">{text}</pre>
      <p className="mt-2 text-xs text-text-muted">
        Works with any OpenAI-compatible client pointed at <code className="font-mono">{endpoint}</code>.
        See the result in <a href="/dashboard/usage?tab=logs" className="font-medium text-primary hover:underline">Usage → Logs</a>.
      </p>
    </div>
  );
}

FirstRequestSnippet.propTypes = {
  baseUrl: PropTypes.string,
  keyName: PropTypes.string,
};
