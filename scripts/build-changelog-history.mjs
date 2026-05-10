/**
 * Builds `status-data/changelog-history.json` from `git log` (status + optional news app).
 * That file is **not** loaded by the public changelog page — release notes use only
 * `changelog.json`. Keep this script for optional internal archival or tooling; safe to run in CI without affecting the live site.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_ROOT = resolve(__dirname, "..");

/** Default sibling clone path; override with BRIEFPK_APP_REPO. */
const DEFAULT_APP_REPO = resolve(__dirname, "..", "..", "brief-pk-newsfeed-original");

function classify(subject) {
  const s = subject.toLowerCase();
  if (s.startsWith("feat") || s.includes("launch") || s.includes("redesign") || s.includes("overhaul")) return "feature";
  if (s.startsWith("fix") || s.includes("hotfix")) return "fix";
  if (s.startsWith("docs") || s.startsWith("doc:")) return "docs";
  if (s.includes("security") || s.includes("harden")) return "security";
  if (s.includes("cname") || s.includes("domain") || s.includes("pages")) return "domain";
  if (s.startsWith("chore")) return "ops";
  return "improvement";
}

function tagsFor(subject, repoTag) {
  const s = subject.toLowerCase();
  const tags = [];
  if (s.includes("snapshot")) tags.push("snapshot-automation");
  if (s.includes("merge")) tags.push("merge");
  if (s.includes("mobile")) tags.push("mobile");
  if (s.includes("login")) tags.push("login-health");
  if (!tags.length) tags.push("git-history");
  tags.push(repoTag);
  return [...new Set(tags)];
}

function readGitLog(repoRoot, commitUrlBase, repoTag) {
  const raw = execSync("git log --date=short --pretty=format:'%H|%ad|%s'", {
    encoding: "utf8",
    cwd: repoRoot
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split("|");
      const title = rest.join("|").trim();
      return {
        id: `git-${repoTag}-${sha.slice(0, 10)}`,
        date,
        type: classify(title),
        title,
        summary: "Historical commit from repository history.",
        tags: tagsFor(title, repoTag),
        links: [
          {
            label: `Commit ${sha.slice(0, 7)}`,
            url: `${commitUrlBase}/${sha.slice(0, 7)}`
          }
        ]
      };
    });
}

async function main() {
  const appPath = process.env.BRIEFPK_APP_REPO || DEFAULT_APP_REPO;

  const statusEntries = readGitLog(
    STATUS_ROOT,
    "https://github.com/raastey/briefpknews-status/commit",
    "status-site"
  );

  let appEntries = [];
  if (existsSync(appPath) && existsSync(resolve(appPath, ".git"))) {
    try {
      appEntries = readGitLog(
        appPath,
        "https://github.com/raastey/brief-pk-newsfeed-original/commit",
        "news-app"
      );
    } catch (e) {
      console.warn(`Skipping news-app git log (${appPath}):`, e.message);
    }
  } else {
    console.warn(`News app repo not found at ${appPath} — only status-site history included. Set BRIEFPK_APP_REPO to merge product commits.`);
  }

  const merged = [...statusEntries, ...appEntries].sort((a, b) => {
    const da = new Date(b.date) - new Date(a.date);
    if (da !== 0) return da;
    return String(a.id).localeCompare(String(b.id));
  });

  const body = {
    generatedAt: new Date().toISOString(),
    source: "git log (merged)",
    repositories: [
      { id: "status-site", commits: statusEntries.length },
      { id: "news-app", commits: appEntries.length }
    ],
    totalCommits: merged.length,
    entries: merged
  };

  const outFile = resolve(STATUS_ROOT, "status-data/changelog-history.json");
  await writeFile(outFile, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(
    `wrote ${outFile} with ${merged.length} entries (status-site: ${statusEntries.length}, news-app: ${appEntries.length})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
