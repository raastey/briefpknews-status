import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

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

function tagsFor(subject) {
  const s = subject.toLowerCase();
  const tags = [];
  if (s.includes("snapshot")) tags.push("snapshot-automation");
  if (s.includes("merge")) tags.push("merge");
  if (s.includes("mobile")) tags.push("mobile");
  if (s.includes("login")) tags.push("login-health");
  if (!tags.length) tags.push("git-history");
  return tags;
}

async function main() {
  const raw = execSync("git log --date=short --pretty=format:'%H|%ad|%s'", { encoding: "utf8" });
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split("|");
      const title = rest.join("|").trim();
      return {
        id: `git-${sha.slice(0, 10)}`,
        date,
        type: classify(title),
        title,
        summary: "Historical commit from repository history.",
        tags: tagsFor(title),
        links: [
          {
            label: `Commit ${sha.slice(0, 7)}`,
            url: `https://github.com/raastey/briefpknews-status/commit/${sha.slice(0, 7)}`
          }
        ]
      };
    });

  const body = {
    generatedAt: new Date().toISOString(),
    source: "git log",
    totalCommits: entries.length,
    entries
  };

  await writeFile("status-data/changelog-history.json", `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(`wrote status-data/changelog-history.json with ${entries.length} entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
