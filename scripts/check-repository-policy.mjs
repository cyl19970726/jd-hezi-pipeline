import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbidden = [
  {
    label: "local operational state",
    test: (path) => path.split("/").includes(".hezi"),
  },
  {
    label: "database or database sidecar",
    test: (path) =>
      /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(
        path,
      ),
  },
  {
    label: "backup or credential file",
    test: (path) =>
      /(?:^|\/)(?:backups?|cookies?|browser-profile)(?:\/|\.|$)/i.test(path) ||
      /(?:^|\/)\.env$/.test(path) ||
      /\.(?:pem|key|p12|pfx)$/i.test(path),
  },
  {
    label: "private report or evidence",
    test: (path) =>
      /(?:^|\/)(?:reports?|docs\/(?:research|evidence))\//i.test(path),
  },
  {
    label: "customer or order export",
    test: (path) =>
      /(?:^|\/)(?:customers?|orders?)(?:[-_.][^/]*)?\.(?:csv|tsv|xlsx?|json|ndjson)$/i.test(
        path,
      ),
  },
];

const secretPatterns = [
  {
    label: "private key",
    test: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { label: "GitHub token", test: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  {
    label: "fine-grained GitHub token",
    test: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  },
  {
    label: "OpenAI-style secret",
    test: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  },
];

const ruleFixtures = {
  rejected: [
    ".hezi/state.json",
    "state/shop.db",
    "state/shop.db-wal",
    "state/shop.db-shm",
    "state/shop.sqlite",
    "backups/latest/manifest.json",
    ".env",
    "certs/private.pem",
    "reports/private.json",
    "docs/research/shop-notes.md",
    "docs/evidence/receipt.json",
    "exports/orders.csv",
  ],
  accepted: [
    "src/store.ts",
    "src/analytics/orders.ts",
    "docs/architecture.md",
    "test/fixtures/fabricated-order.ts",
    ".env.example",
  ],
};

const violatesPolicy = (path) => forbidden.some((rule) => rule.test(path));
for (const path of ruleFixtures.rejected) {
  if (!violatesPolicy(path))
    throw new Error(`Policy self-test failed to reject: ${path}`);
}
for (const path of ruleFixtures.accepted) {
  if (violatesPolicy(path))
    throw new Error(`Policy self-test rejected safe fixture: ${path}`);
}

const violations = [];
for (const path of files) {
  for (const rule of forbidden) {
    if (rule.test(path)) violations.push(`${path} (${rule.label})`);
  }
  const content = readFileSync(path, "utf8");
  for (const rule of secretPatterns) {
    if (rule.test.test(content)) violations.push(`${path} (${rule.label})`);
  }
}

if (violations.length > 0) {
  console.error("Repository policy rejected unsafe tracked content:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Repository policy passed for ${files.length} tracked files.`);
}
