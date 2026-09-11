/**
 * Mints a bearer token for local development.
 *
 * In production the billing system issues these; this exists so a developer can
 * run the app against a local worker without standing up billing first.
 *
 *   node --experimental-sqlite src/token-cli.ts --secret
 *   node --experimental-sqlite src/token-cli.ts --sub dev-user --tier paid
 */
import { generateSecret, issueToken } from "./auth.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--secret")) {
  // eslint-disable-next-line no-console
  console.log(generateSecret());
  process.exit(0);
}

const secret = flag("secret-value") ?? process.env.LOOM_TOKEN_SECRET;
if (secret === undefined || secret.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    "Set LOOM_TOKEN_SECRET first, or generate one with: node src/token-cli.ts --secret",
  );
  process.exit(1);
}

const tier = flag("tier") === "paid" ? "paid" : "free";
// eslint-disable-next-line no-console
console.log(issueToken({ sub: flag("sub") ?? "dev-user", tier }, secret));
