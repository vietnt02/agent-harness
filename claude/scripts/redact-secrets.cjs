#!/usr/bin/env node
/**
 * redact-secrets.cjs - stdin -> stdout with credential values replaced by `[redacted]`: a token by its
 * known prefix (GitHub, GitLab, Slack, OpenAI/Anthropic-style `sk-`, AWS access key, Google API key),
 * the value of a `*_TOKEN=` / `*_KEY=` / `*_SECRET=` / `*_PASSWORD=` pair, and the word after
 * "password" / "mật khẩu" (`:`, `=` or "là"). The label stays, so a reader still sees that a secret
 * was there. For dumps of chat, mail or logs read into a conversation: `… | node redact-secrets.cjs`.
 */
'use strict';

const RULES = [
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD))(\s*[=:]\s*)(?!\[redacted\])[^\s"'\\,}]+/g, '$1$2[redacted]'],
  [/(\b(?:password|passwd|pwd)|mật khẩu(?: tạm)?)(\s*[:=]\s*|\s+là\s+)(?!\[redacted\])[^\s"'\\,}]+/giu, '$1$2[redacted]'],
];

function redact(text) {
  let out = String(text);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

module.exports = { redact };
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => process.stdout.write(redact(raw)));
}
