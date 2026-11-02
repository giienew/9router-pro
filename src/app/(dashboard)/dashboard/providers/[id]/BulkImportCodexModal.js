"use client";

import { useState, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const PLACEHOLDER = `[
  {
    "accessToken": "eyJhbGc...",
    "refreshToken": "rt_...",
    "idToken": "eyJhbGc...",
    "email": "user@example.com"
  }
]`;

function normalizeToArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.accounts)) return parsed.accounts;
    return [parsed];
  }
  return null;
}

export default function BulkImportCodexModal({ isOpen, onClose, onSuccess }) {
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [fileCountInfo, setFileCountInfo] = useState(null);
  const fileInputRef = useRef(null);

  const handleClose = () => {
    if (submitting) return;
    setJsonText("");
    setParseError("");
    setResult(null);
    setFileCountInfo(null);
    setIsDragging(false);
    onClose();
  };

  const handleSubmit = async () => {
    setParseError("");
    setResult(null);

    const trimmed = jsonText.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      setParseError(`${translate("Invalid JSON")}: ${err.message}`);
      return;
    }

    const accounts = normalizeToArray(parsed);
    if (!accounts || accounts.length === 0) {
      setParseError(translate("No accounts found in input"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/oauth/codex/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();
      if (!res.ok) {
        setParseError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      setResult(data);
      if (data.success > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setParseError(err.message || translate("Request failed"));
    } finally {
      setSubmitting(false);
    }
  };

  // File import, same pattern as the GrokCli bulk modal: .json files land
  // in the textarea so the existing submit path handles them unchanged.
  const processFiles = async (files) => {
    if (!files || files.length === 0) return;
    setParseError("");
    const jsonFiles = Array.from(files).filter(
      (file) => file.name.endsWith(".json") || file.type === "application/json" || file.type === ""
    );
    if (jsonFiles.length === 0) {
      setParseError(translate("Please select valid .json files"));
      return;
    }
    try {
      const allAccounts = [];
      for (const file of jsonFiles) {
        const text = await file.text();
        const accountsFromFile = normalizeToArray(JSON.parse(text));
        if (Array.isArray(accountsFromFile)) {
          allAccounts.push(...accountsFromFile);
        } else if (accountsFromFile) {
          allAccounts.push(accountsFromFile);
        }
      }
      if (allAccounts.length === 0) {
        setParseError(translate("No accounts found in selected files"));
        return;
      }
      setJsonText(JSON.stringify(allAccounts, null, 2));
      setFileCountInfo({
        filesCount: jsonFiles.length,
        accountsCount: allAccounts.length,
      });
    } catch (err) {
      setParseError(`${translate("Error reading files")}: ${err.message}`);
    }
  };

  const handleFileInputChange = (e) => {
    processFiles(e.target.files);
    if (e.target) e.target.value = "";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    processFiles(e.dataTransfer.files);
  };

  const failedItems = result?.results?.filter((r) => !r.ok) || [];

  return (
    <Modal isOpen={isOpen} title={translate("Bulk Add Codex Accounts")} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          {translate(
            "Paste an array of codex account JSON objects. Each must include accessToken (and ideally refreshToken, idToken)."
          )}
        </p>

        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon="upload_file"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
          >
            {translate("Upload JSON Files")}
          </Button>
        </div>

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative rounded border transition-colors ${
            isDragging
              ? "border-primary bg-primary/10 ring-2 ring-primary/30"
              : "border-accent/30 bg-sidebar"
          }`}
        >
          <textarea
            className="w-full rounded bg-transparent p-2.5 text-sm font-mono resize-y min-h-[240px] focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={PLACEHOLDER}
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              setFileCountInfo(null);
            }}
            disabled={submitting}
          />

          {isDragging && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-sidebar/90 rounded pointer-events-none backdrop-blur-xs">
              <span className="material-symbols-outlined text-3xl text-primary mb-1">upload_file</span>
              <span className="text-sm font-medium text-primary">
                {translate("Drop .json files here")}
              </span>
            </div>
          )}
        </div>

        {fileCountInfo && (
          <div className="flex items-center gap-1.5 text-xs text-green-400 font-medium bg-green-500/10 border border-green-500/20 px-2.5 py-1.5 rounded">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            <span>
              {translate("Loaded")} {fileCountInfo.accountsCount} {translate("account(s) from")}{" "}
              {fileCountInfo.filesCount} {translate("file(s)")}
            </span>
          </div>
        )}

        {parseError && (
          <p className="text-xs text-red-500 break-words">{parseError}</p>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <div
              className={`text-sm font-medium ${
                result.failed > 0 ? "text-yellow-400" : "text-green-400"
              }`}
            >
              ✓ {result.success} {translate("added")}
              {result.failed > 0 ? `, ✗ ${result.failed} ${translate("failed")}` : ""}
            </div>
            {failedItems.length > 0 && (
              <ul className="rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono max-h-40 overflow-y-auto">
                {failedItems.map((item) => (
                  <li key={item.index} className="text-red-400">
                    [{item.index}] {item.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={submitting || !jsonText.trim()}
          >
            {submitting ? translate("Importing...") : translate("Import All")}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BulkImportCodexModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
