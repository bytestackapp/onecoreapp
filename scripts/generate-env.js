// Runs during the Vercel build (see package.json "build" script). Reads
// the two environment variables you set in Vercel's dashboard and writes
// them into js/env-config.js, which supabase-client.js imports at runtime.
//
// This keeps the real values out of your Git repository. It does NOT hide
// them from the browser — a plain static site has no server to hide a
// secret behind, and the Supabase anon key is meant to be public anyway
// (Row Level Security, not secrecy, is what protects your data).

const fs = require("fs");
const path = require("path");

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    "\nMissing SUPABASE_URL and/or SUPABASE_ANON_KEY.\n" +
      "Set them in Vercel: Project Settings → Environment Variables.\n" +
      "For local dev, copy js/env-config.example.js to js/env-config.js and fill in real values.\n"
  );
  process.exit(1);
}

const outPath = path.join(__dirname, "..", "js", "env-config.js");
const contents = `// AUTO-GENERATED at build time by scripts/generate-env.js — do not edit,
// and do not commit this file (it's in .gitignore).
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(anonKey)};
`;

fs.writeFileSync(outPath, contents);
console.log(`Wrote ${outPath}`);
