#!/usr/bin/env node
/**
 * redact-secrets.cjs - stdin -> stdout with credential values replaced by `[redacted]`: a token by its
 * known prefix (GitHub, GitLab, Slack, OpenAI/Anthropic-style `sk-`, AWS access key, Google API key),
 * Lark token, JWT, Bearer, PEM private key, URL credentials), the value of a `token`/`key`/`secret`/
 * `password` pair in any case, quoted or not (JSON included), and the word after "password" / "mật khẩu"
 * (`:`, `=` or "là"; a question such as "mật khẩu là gì" is left). The label stays, so a reader still sees that a secret
 * was there. For dumps of chat, mail or logs read into a conversation: `… | node redact-secrets.cjs`.
 */
'use strict';

// A bare "key" is ordinary text ("primary key: id"): only a prefixed one (`api_key`) counts.
const KEY = String.raw`(?:(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|pwd|apikey)|(?:[A-Za-z0-9]+[_-])+key)`;
const CAMEL = String.raw`[a-z][A-Za-z0-9]*(?:Token|Key|Secret|Password)`; // appSecret, accessToken
const Q = String.raw`(?:\\)*["']?`; // an optional quote, escaped once or more (JSON inside JSON)
const VALUE = String.raw`(?!\[redacted\]|null\b)[^\s"'\\,}]+`;
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\b[tu]-[A-Za-z0-9_-]{30,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/(\bBearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [new RegExp(String.raw`((?:^|[^A-Za-z0-9])${KEY}${Q})(\s*[=:]\s*)(${Q})${VALUE}`, 'gi'), '$1$2$3[redacted]'],
  [new RegExp(String.raw`((?:^|[^A-Za-z0-9])${CAMEL}${Q})(\s*[=:]\s*)(${Q})${VALUE}`, 'g'), '$1$2$3[redacted]'],
  [new RegExp(String.raw`((?:^|[^\p{L}])(?:password|passwd|pwd|pw|mật khẩu)(?: (?:tạm|wifi|mới))?${Q})(\s*[:=]\s*|\s+là\s+)(${Q})(?!(?:gì|gi|đâu|bao|chưa|nào|sao)(?:$|[^\p{L}]))${VALUE}`, 'giu'), '$1$2$3[redacted]'],
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
