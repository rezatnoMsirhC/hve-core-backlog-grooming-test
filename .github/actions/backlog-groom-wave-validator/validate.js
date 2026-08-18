const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (value) => crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const writeOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
const assertPositiveUniqueIds = (name, ids) => {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length) {
    throw new Error(`${name} must contain unique positive safe integers`);
  }
};

const manifest = JSON.parse(fs.readFileSync(process.env.INPUT_MANIFEST_PATH, "utf8"));
const manifestKeys = [
  "schema_version", "sweep_id", "snapshot_digest", "wave_number", "required_waves",
  "prior_checkpoint_run_id", "prior_checkpoint_artifact_id", "prior_checkpoint_digest",
  "ordered_issue_ids", "planned_aic", "run_id", "attempt", "shards", "manifest_digest",
];
const shardKeys = [
  "shard_id", "ordered_candidate_ids", "priority_candidate_ids", "round_robin_candidate_ids",
  "total_open_inventory", "prior_cursor", "worker_timeout_minutes",
];
const { manifest_digest: recordedManifestDigest, ...manifestMaterial } = manifest;
if (!exactKeys(manifest, manifestKeys) || manifest.schema_version !== "backlog-grooming-wave-manifest/v1" ||
    !/^[a-f0-9]{64}$/.test(manifest.sweep_id) || !/^[a-f0-9]{64}$/.test(manifest.snapshot_digest) ||
    manifest.run_id !== process.env.INPUT_EXPECTED_RUN_ID ||
    manifest.attempt !== Number(process.env.INPUT_EXPECTED_ATTEMPT) ||
    !Number.isSafeInteger(manifest.wave_number) || manifest.wave_number <= 0 ||
    !Number.isSafeInteger(manifest.required_waves) || manifest.wave_number > manifest.required_waves ||
    !Number.isSafeInteger(manifest.planned_aic) || manifest.planned_aic < 0 ||
    !Array.isArray(manifest.shards) || digest(manifestMaterial) !== recordedManifestDigest) {
  throw new Error("Wave manifest digest mismatch or invalid schema/identity");
}
assertPositiveUniqueIds("manifest ordered_issue_ids", manifest.ordered_issue_ids);
const shardIds = new Set();
const plannedIssueIds = [];
for (const shard of manifest.shards) {
  if (!exactKeys(shard, shardKeys) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(shard.shard_id) ||
      shardIds.has(shard.shard_id) || !Number.isSafeInteger(shard.total_open_inventory) ||
      shard.total_open_inventory < manifest.ordered_issue_ids.length ||
      !Number.isSafeInteger(shard.prior_cursor) || shard.prior_cursor < 0 ||
      !Number.isSafeInteger(shard.worker_timeout_minutes) || shard.worker_timeout_minutes <= 0) {
    throw new Error("Wave manifest shard schema is invalid");
  }
  assertPositiveUniqueIds(`${shard.shard_id} ordered_candidate_ids`, shard.ordered_candidate_ids);
  assertPositiveUniqueIds(`${shard.shard_id} priority_candidate_ids`, shard.priority_candidate_ids);
  assertPositiveUniqueIds(`${shard.shard_id} round_robin_candidate_ids`, shard.round_robin_candidate_ids);
  const cohortIds = [...shard.priority_candidate_ids, ...shard.round_robin_candidate_ids].sort((a, b) => a - b);
  if (JSON.stringify(cohortIds) !== JSON.stringify(shard.ordered_candidate_ids)) {
    throw new Error("Wave manifest shard cohorts do not match its candidate IDs");
  }
  shardIds.add(shard.shard_id);
  plannedIssueIds.push(...shard.ordered_candidate_ids);
}
if (JSON.stringify(plannedIssueIds.sort((a, b) => a - b)) !== JSON.stringify(manifest.ordered_issue_ids)) {
  throw new Error("Wave manifest shards do not exactly partition the wave issue IDs");
}

const resultPaths = [];
const collect = (directory) => {
  if (!fs.existsSync(directory)) return;
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(entryPath);
    else if (entry.name === "shard-result.json") resultPaths.push(entryPath);
  });
};
collect(process.env.INPUT_RESULTS_DIRECTORY);

const byShard = new Map();
const rowsByIssue = new Map();
const resultDigests = [];
const reportKeys = ["run", "issues"];
const runKeys = [
  "timestamp", "total_open_inventory", "assessed", "priority_cohort", "round_robin_cohort",
  "deferred", "stop_reason", "next_cursor",
];
const rowKeys = [
  "issue", "title", "selection_reason", "activity_and_ownership_context", "acceptance_signals",
  "repository_evidence", "lineage_evidence", "similarity_outcome", "disposition", "grooming_finding",
  "recommended_next_step", "assessment_status",
];
for (const resultPath of resultPaths) {
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (!exactKeys(result, [
    "schema_version", "run_id", "attempt", "shard_id", "manifest_digest",
    "ordered_candidate_ids", "producer", "started_at", "completed_at",
    "report_data", "result_digest",
  ]) || result.schema_version !== "backlog-grooming-shard-result/v1") {
    throw new Error("Malformed shard result envelope");
  }
  const expected = manifest.shards.find((shard) => shard.shard_id === result.shard_id);
  if (!expected || byShard.has(result.shard_id) ||
      result.run_id !== process.env.INPUT_EXPECTED_RUN_ID ||
      result.attempt !== Number(process.env.INPUT_EXPECTED_ATTEMPT) ||
      result.manifest_digest !== manifest.manifest_digest ||
      result.producer !== "backlog-groom/result-job" ||
      !Number.isFinite(Date.parse(result.started_at)) || !Number.isFinite(Date.parse(result.completed_at)) ||
      Date.parse(result.completed_at) < Date.parse(result.started_at) ||
      JSON.stringify(result.ordered_candidate_ids) !== JSON.stringify(expected.ordered_candidate_ids) ||
      !exactKeys(result.report_data, reportKeys) || !exactKeys(result.report_data.run, runKeys) ||
      !Array.isArray(result.report_data.issues) ||
      result.report_data.run.total_open_inventory !== expected.total_open_inventory ||
      result.report_data.run.priority_cohort !== expected.priority_candidate_ids.length ||
      result.report_data.run.round_robin_cohort !== expected.round_robin_candidate_ids.length ||
      result.report_data.run.assessed + result.report_data.run.deferred !== result.report_data.issues.length) {
    throw new Error("Missing, duplicate, stale, unexpected, or manifest-mismatched shard result");
  }
  const { result_digest: recordedResultDigest, ...resultMaterial } = result;
  if (digest(resultMaterial) !== recordedResultDigest) throw new Error("Shard result digest mismatch");
  byShard.set(result.shard_id, result);
  resultDigests.push(result.result_digest);
  for (const row of result.report_data.issues) {
    if (!exactKeys(row, rowKeys) || !result.ordered_candidate_ids.includes(row.issue) ||
        !["Assessed", "Deferred"].includes(row.assessment_status) || rowsByIssue.has(row.issue)) {
      throw new Error(`Malformed, duplicate, or out-of-shard wave issue ${row.issue}`);
    }
    rowsByIssue.set(row.issue, row);
  }
}
if (byShard.size !== manifest.shards.length) throw new Error("Wave result set is incomplete");
const rows = manifest.ordered_issue_ids.map((issue) => rowsByIssue.get(issue));
if (rows.some((row) => !row) || rowsByIssue.size !== manifest.ordered_issue_ids.length) {
  throw new Error("Wave issue coverage is incomplete or out of snapshot");
}
const assessedIds = rows.filter((row) => row.assessment_status === "Assessed").map((row) => row.issue);
const deferredIds = rows.filter((row) => row.assessment_status === "Deferred").map((row) => row.issue);
if (assessedIds.length + deferredIds.length !== rows.length) throw new Error("Wave row status is invalid");
const aggregateMaterial = {
  schema_version: "backlog-grooming-wave-aggregate/v1",
  sweep_id: manifest.sweep_id,
  snapshot_digest: manifest.snapshot_digest,
  wave_number: manifest.wave_number,
  required_waves: manifest.required_waves,
  manifest_digest: manifest.manifest_digest,
  source_run_id: process.env.INPUT_EXPECTED_RUN_ID,
  source_attempt: Number(process.env.INPUT_EXPECTED_ATTEMPT),
  result_digests: resultDigests.sort(),
  assessed_issue_ids: assessedIds,
  deferred_issue_ids: deferredIds,
  rows,
};
const aggregate = { ...aggregateMaterial, aggregate_digest: digest(aggregateMaterial) };
fs.mkdirSync(process.env.INPUT_AGGREGATE_DIRECTORY, { recursive: true });
fs.writeFileSync(
  path.join(process.env.INPUT_AGGREGATE_DIRECTORY, "aggregate.json"),
  `${JSON.stringify(aggregate, null, 2)}\n`,
);
writeOutput("aggregate-digest", aggregate.aggregate_digest);
writeOutput("assessed-ids", JSON.stringify(assessedIds));
writeOutput("deferred-ids", JSON.stringify(deferredIds));
