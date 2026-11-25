/**
 * Redaction for agent callers. Runs in the API, not in the MCP server, so every present and future agent gets it.
 * Pattern matching is a safety net, not a guarantee (see SECURITY.md).
 */
const RULES: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[email]'],
  [/\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]*|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_\w{20,})/g, '[secret]'],
  [/\b(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, '[secret]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[number]'],
  [/(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, '[phone]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];

/** Invisible and direction-changing characters can hide instructions from a human reviewer. */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

export const stripHidden = (s: string): string => s.replace(HIDDEN, '');
export const redactText = (s: string): string => RULES.reduce((t, [re, to]) => t.replace(re, to), stripHidden(s.normalize('NFKC')));
