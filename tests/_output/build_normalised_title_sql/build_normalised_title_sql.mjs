// scripts/build_normalised_title_sql.ts
import { readFileSync } from "node:fs";

// src/catalogue/normalise_release_title.ts
var MASTER_MARKERS = [
  "remaster",
  "remastered",
  "re-master",
  "re-mastered",
  "remix",
  "mix",
  "master",
  "anniversary",
  "deluxe",
  "collector",
  "edition",
  "version",
  "expanded",
  "reissue",
  "mono",
  "stereo"
];
var IDENTITY_MARKERS = ["live", "soundtrack", "demo", "acoustic"];
var TRAILING_SEGMENT = /\s*[([]([^)\]]*)[)\]]\s*$/;
var TRAILING_DASH_SUFFIX = /\s+-\s+([^-]+)$/;
function isMasterSuffix(suffix) {
  const lowered = suffix.toLowerCase();
  if (IDENTITY_MARKERS.some((marker) => lowered.includes(marker))) {
    return false;
  }
  return MASTER_MARKERS.some((marker) => lowered.includes(marker));
}
function stripBareLivenessSuffix(title) {
  const bracketed = title.match(TRAILING_SEGMENT);
  if (bracketed !== null && /^live$/i.test(bracketed[1].trim())) {
    return title.slice(0, bracketed.index).trim();
  }
  return title;
}
function normaliseReleaseTitle(title) {
  const working = stripMasterSuffixes(title);
  const cleaned = stripLeadingArticle(working.toLowerCase());
  return cleaned.length === 0 ? title.trim().toLowerCase() : cleaned;
}
function stripMasterSuffixes(title) {
  let working = title.trim();
  for (let pass = 0; pass < MAXIMUM_SUFFIX_PASSES; pass += 1) {
    const bracketed = working.match(TRAILING_SEGMENT);
    if (bracketed !== null && isMasterSuffix(bracketed[1])) {
      working = working.slice(0, bracketed.index).trim();
      continue;
    }
    const dashed = working.match(TRAILING_DASH_SUFFIX);
    if (dashed !== null && isMasterSuffix(dashed[1])) {
      working = working.slice(0, dashed.index).trim();
      continue;
    }
    break;
  }
  working = stripBareLivenessSuffix(working);
  for (let pass = 0; pass < MAXIMUM_SUFFIX_PASSES; pass += 1) {
    const bracketed = working.match(TRAILING_SEGMENT);
    if (bracketed !== null && isMasterSuffix(bracketed[1])) {
      working = working.slice(0, bracketed.index).trim();
      continue;
    }
    break;
  }
  const trimmed = working.trim();
  return trimmed.length === 0 ? title.trim() : trimmed;
}
function stripLeadingArticle(title) {
  const stripped = title.replace(/^the\s+/, "");
  return stripped.length === 0 ? title : stripped;
}
var MAXIMUM_SUFFIX_PASSES = 3;

// scripts/build_normalised_title_sql.ts
function quote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
var rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const row of rows) {
  process.stdout.write(
    `UPDATE track SET normalised_title = ${quote(normaliseReleaseTitle(row.name))} WHERE uri = ${quote(row.uri)};
`
  );
}
process.stderr.write(`${rows.length} titles
`);
