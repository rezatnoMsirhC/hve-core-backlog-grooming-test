const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const WORKFLOW_PATH = ".github/workflows/backlog-groom-multi-wave-proof.yml";
const PROTOCOL_VERSION = "backlog-grooming-multi-wave-proof/v1";
const ARTIFACT_PREFIX = "backlog-groom-multi-wave-proof";
const DISCOVERY_RUN_LIMIT = 100;
const DISCOVERY_WAIT_ATTEMPTS = 60;
const PROOF_ROOT = "proof-work";
const AUTHORIZED_CONFLICT_STOP_REASON = "Synthetic conflicting second shard result injection";
const ORIGINAL_STOP_REASON = "Synthetic proof fixture; zero model execution";
const REJECTION_REASON = Object.freeze({
  code: "AUTHENTICATED_CONFLICTING_SHARD_RESULT",
  message: "The production validator rejected one authenticated conflicting shard-result pair",
});
const VALIDATOR_PATH = path.resolve(__dirname, "../backlog-groom-wave-validator/validate.js");

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
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};
const output = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
const input = (name, fallback = "") => process.env[name] ?? fallback;
const integer = (name, value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return parsed;
};
const assertDigest = (name, value) => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
};
const assertPositiveUniqueIds = (name, ids) => {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length) {
    throw new Error(`${name} must contain unique positive safe integers`);
  }
};
const withDigest = (material, field) => ({ ...material, [field]: digest(material) });
const withoutDigest = (value, field) => {
  const copy = { ...value };
  delete copy[field];
  return copy;
};
const assertRecordedDigest = (name, value, field) => {
  assertDigest(`${name} ${field}`, value[field]);
  if (digest(withoutDigest(value, field)) !== value[field]) throw new Error(`${name} digest mismatch`);
};

const validateDiscoveredRuns = (runs, sourceSha) => {
  if (!Array.isArray(runs) || runs.length >= DISCOVERY_RUN_LIMIT) {
    throw new Error("Proof workflow run discovery reached its finite source-SHA limit");
  }
  for (const run of runs) {
    if (run.path !== WORKFLOW_PATH || run.head_sha !== sourceSha) {
      throw new Error("Proof workflow run discovery returned an unexpected producer");
    }
  }
  return runs;
};

const validateDuplicateNoop = (noop, expected) => {
  assertRecordedDigest("duplicate no-op", noop, "noop_digest");
  const keys = [
    "schema_version", "proof_id", "scenario", "wave_number", "source_run_id", "source_attempt",
    "source_sha", "accepted_checkpoint_run_id", "accepted_checkpoint_artifact_id",
    "accepted_checkpoint_digest", "predecessor_checkpoint_digest", "fixture_created",
    "validator_invoked", "checkpoint_created", "successor_dispatched", "noop_digest",
  ];
  if (!exactKeys(noop, keys) ||
      noop.schema_version !== "backlog-grooming-multi-wave-proof-duplicate-noop/v1" ||
      noop.proof_id !== expected.proofId || noop.scenario !== "duplicate-dispatch" ||
      noop.wave_number !== expected.waveNumber || noop.source_run_id !== expected.sourceRunId ||
      noop.source_attempt !== expected.sourceAttempt || noop.source_sha !== expected.sourceSha ||
      noop.accepted_checkpoint_run_id !== expected.acceptedCheckpointRunId ||
      noop.accepted_checkpoint_artifact_id !== expected.acceptedCheckpointArtifactId ||
      noop.accepted_checkpoint_digest !== expected.acceptedCheckpointDigest ||
      noop.predecessor_checkpoint_digest !== expected.predecessorCheckpointDigest ||
      noop.fixture_created !== false || noop.validator_invoked !== false ||
      noop.checkpoint_created !== false || noop.successor_dispatched !== false) {
    throw new Error("Duplicate no-op evidence is not bound to the exact accepted checkpoint transition");
  }
  return noop;
};

const validateInjectedConflictFixture = (manifest, fixtureMetadata, results, expected) => {
  assertRecordedDigest("injected manifest", manifest, "manifest_digest");
  assertRecordedDigest("injected fixture metadata", fixtureMetadata, "fixture_digest");
  const fixtureKeys = [
    "schema_version", "proof_id", "scenario", "wave_number", "source_run_id", "source_attempt",
    "source_sha", "manifest_digest", "result_digests", "injected_conflict", "model_execution",
    "observed_model_use", "fixture_digest",
  ];
  if (!exactKeys(fixtureMetadata, fixtureKeys) ||
      fixtureMetadata.schema_version !== "backlog-grooming-multi-wave-proof-fixtures/v1" ||
      fixtureMetadata.proof_id !== manifest.sweep_id || fixtureMetadata.proof_id !== expected.proofId ||
      fixtureMetadata.scenario !== "failed-wave-resume" || fixtureMetadata.wave_number !== 2 ||
      fixtureMetadata.source_run_id !== manifest.run_id || fixtureMetadata.source_run_id !== expected.runId ||
      fixtureMetadata.source_attempt !== manifest.attempt || fixtureMetadata.source_attempt !== expected.attempt ||
      fixtureMetadata.source_sha !== expected.sourceSha ||
      fixtureMetadata.manifest_digest !== manifest.manifest_digest ||
      fixtureMetadata.manifest_digest !== expected.manifestDigest ||
      fixtureMetadata.fixture_digest !== expected.fixtureDigest || fixtureMetadata.injected_conflict !== true ||
      fixtureMetadata.model_execution !== "none" || fixtureMetadata.observed_model_use !== 0) {
    throw new Error("Injected fixture metadata is not bound to the exact failed wave manifest");
  }
  if (!Array.isArray(manifest.shards) || results.length !== manifest.shards.length + 1) {
    throw new Error("Injected fixture must contain one result per shard plus one authorized conflict");
  }
  const recordedOriginalDigests = [...fixtureMetadata.result_digests].sort();
  if (recordedOriginalDigests.length !== manifest.shards.length ||
      new Set(recordedOriginalDigests).size !== recordedOriginalDigests.length) {
    throw new Error("Injected fixture metadata must identify exactly one original result per shard");
  }
  for (const result of results) assertRecordedDigest("injected shard result", result, "result_digest");
  const originals = results.filter((result) => recordedOriginalDigests.includes(result.result_digest));
  const conflicts = results.filter((result) => !recordedOriginalDigests.includes(result.result_digest));
  if (originals.length !== manifest.shards.length || conflicts.length !== 1 ||
      JSON.stringify(originals.map((result) => result.result_digest).sort()) !==
        JSON.stringify(recordedOriginalDigests)) {
    throw new Error("Injected fixture does not contain the exact recorded original result set");
  }
  for (const shard of manifest.shards) {
    const matches = originals.filter((result) => result.shard_id === shard.shard_id);
    if (matches.length !== 1 || matches[0].run_id !== manifest.run_id || matches[0].attempt !== manifest.attempt ||
        matches[0].manifest_digest !== manifest.manifest_digest ||
        JSON.stringify(matches[0].ordered_candidate_ids) !== JSON.stringify(shard.ordered_candidate_ids)) {
      throw new Error("Injected fixture original result identity or candidate set is invalid");
    }
  }
  const conflict = conflicts[0];
  const original = originals.find((result) => result.shard_id === conflict.shard_id);
  if (!original || original.report_data?.run?.stop_reason !== ORIGINAL_STOP_REASON) {
    throw new Error("Injected fixture conflict does not duplicate one expected original shard");
  }
  const authorizedConflict = JSON.parse(JSON.stringify(original));
  authorizedConflict.report_data.run.stop_reason = AUTHORIZED_CONFLICT_STOP_REASON;
  authorizedConflict.result_digest = digest(withoutDigest(authorizedConflict, "result_digest"));
  if (canonicalize(conflict) !== canonicalize(authorizedConflict)) {
    throw new Error("Injected fixture conflict differs outside the authorized stop_reason and result_digest mutation");
  }
  return { original, conflict, originals };
};

const expectedAggregate = (manifest, originals) => {
  const rowsByIssue = new Map();
  for (const result of originals) {
    for (const row of result.report_data.issues) {
      if (rowsByIssue.has(row.issue)) throw new Error("Control fixture contains duplicate issue rows");
      rowsByIssue.set(row.issue, row);
    }
  }
  const rows = manifest.ordered_issue_ids.map((issue) => rowsByIssue.get(issue));
  if (rows.some((row) => !row) || rowsByIssue.size !== manifest.ordered_issue_ids.length) {
    throw new Error("Control fixture does not exactly cover the manifest issue IDs");
  }
  const material = {
    schema_version: "backlog-grooming-wave-aggregate/v1",
    sweep_id: manifest.sweep_id,
    snapshot_digest: manifest.snapshot_digest,
    wave_number: manifest.wave_number,
    required_waves: manifest.required_waves,
    manifest_digest: manifest.manifest_digest,
    source_run_id: manifest.run_id,
    source_attempt: manifest.attempt,
    result_digests: originals.map((result) => result.result_digest).sort(),
    assessed_issue_ids: rows.filter((row) => row.assessment_status === "Assessed").map((row) => row.issue),
    deferred_issue_ids: rows.filter((row) => row.assessment_status === "Deferred").map((row) => row.issue),
    rows,
  };
  return withDigest(material, "aggregate_digest");
};

const validateControlAggregate = (aggregate, manifest, originals) => {
  assertRecordedDigest("control aggregate", aggregate, "aggregate_digest");
  const expected = expectedAggregate(manifest, originals);
  if (canonicalize(aggregate) !== canonicalize(expected)) {
    throw new Error("Production validator control aggregate digest or exact coverage is invalid");
  }
  return aggregate;
};

const runProductionControl = (manifestPath, manifest, originals, resultsDirectory, aggregateDirectory) => {
  fs.rmSync(resultsDirectory, { recursive: true, force: true });
  fs.rmSync(aggregateDirectory, { recursive: true, force: true });
  for (const result of originals) {
    writeJson(path.join(resultsDirectory, result.shard_id, "shard-result.json"), result);
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-proof-control-"));
  const githubOutput = path.join(temporaryDirectory, "github-output.txt");
  try {
    execFileSync(process.execPath, [VALIDATOR_PATH], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutput,
        INPUT_MANIFEST_PATH: manifestPath,
        INPUT_RESULTS_DIRECTORY: resultsDirectory,
        INPUT_AGGREGATE_DIRECTORY: aggregateDirectory,
        INPUT_EXPECTED_RUN_ID: manifest.run_id,
        INPUT_EXPECTED_ATTEMPT: String(manifest.attempt),
      },
      encoding: "utf8",
      stdio: "pipe",
    });
    const aggregate = readJson(path.join(aggregateDirectory, "aggregate.json"));
    validateControlAggregate(aggregate, manifest, originals);
    const recordedOutput = fs.readFileSync(githubOutput, "utf8");
    if (!recordedOutput.split(/\r?\n/).includes(`aggregate-digest=${aggregate.aggregate_digest}`)) {
      throw new Error("Production validator control output did not record the exact aggregate digest");
    }
    return aggregate;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

const readFixtureResults = (directory) => {
  const results = [];
  const collect = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) collect(entryPath);
      else if (entry.name === "shard-result.json") results.push(readJson(entryPath));
    }
  };
  collect(directory);
  return results;
};

const ghApi = (endpoint) => JSON.parse(execFileSync(
  "gh",
  ["api", endpoint],
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
));
const artifactMetadata = (artifactId) => ghApi(
  `/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${integer("artifact-id", artifactId)}`,
);
const runMetadata = (runId) => ghApi(
  `/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${integer("run-id", runId)}`,
);
const authenticateArtifact = (artifactId, expected) => {
  const artifact = artifactMetadata(artifactId);
  const runId = integer("artifact workflow run ID", artifact.workflow_run?.id);
  const run = runMetadata(runId);
  if (artifact.expired || artifact.name !== expected.name || runId !== integer("expected run ID", expected.runId) ||
      run.path !== WORKFLOW_PATH || run.head_sha !== expected.sourceSha) {
    throw new Error(`Artifact ${artifact.id} failed proof producer authentication`);
  }
  return { artifact, run };
};
const downloadArtifact = (artifactId, destination, expected) => {
  const metadata = authenticateArtifact(artifactId, expected);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const archivePath = `${destination}.zip`;
  const archive = execFileSync(
    "gh",
    ["api", `/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${metadata.artifact.id}/zip`],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  fs.writeFileSync(archivePath, archive);
  execFileSync("unzip", ["-q", archivePath, "-d", destination]);
  fs.rmSync(archivePath, { force: true });
  return metadata;
};
const listProofArtifacts = (proofId) => {
  const response = ghApi(
    `/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/backlog-groom-multi-wave-proof.yml/runs` +
    `?event=workflow_dispatch&head_sha=${process.env.GITHUB_SHA}&per_page=${DISCOVERY_RUN_LIMIT}`,
  );
  const runs = validateDiscoveredRuns(response.workflow_runs ?? [], process.env.GITHUB_SHA);
  const artifacts = [];
  for (const run of runs) {
    const runArtifacts = ghApi(
      `/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${integer("discovered run ID", run.id)}/artifacts?per_page=100`,
    );
    if ((runArtifacts.total_count ?? 0) > 100) {
      throw new Error("Proof workflow run artifact discovery exceeded its finite per-run limit");
    }
    artifacts.push(...(runArtifacts.artifacts ?? []).filter(
      (artifact) => !artifact.expired && artifact.name.startsWith(`${ARTIFACT_PREFIX}-${proofId}-`),
    ));
  }
  return artifacts;
};
const findArtifacts = (artifacts, prefix) => artifacts.filter((artifact) => artifact.name.startsWith(prefix));
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const artifactName = (proofId, kind, wave, runId) => {
  const wavePart = wave ? `-${wave}` : "";
  return `${ARTIFACT_PREFIX}-${proofId}-${kind}${wavePart}-${runId}`;
};

const validateSnapshot = (snapshot) => {
  assertRecordedDigest("snapshot", snapshot, "snapshot_digest");
  if (snapshot.schema_version !== "backlog-grooming-multi-wave-proof-snapshot/v1" ||
      snapshot.protocol_version !== PROTOCOL_VERSION || snapshot.workflow_path !== WORKFLOW_PATH ||
      snapshot.repository !== process.env.GITHUB_REPOSITORY || snapshot.repository_id !== process.env.GITHUB_REPOSITORY_ID ||
      snapshot.source_sha !== process.env.GITHUB_SHA || snapshot.total_snapshot_count !== 25 ||
      snapshot.shard_count !== 2 || snapshot.shard_width !== 5 || snapshot.wave_capacity !== 10 ||
      snapshot.required_waves !== 3 || snapshot.planned_aic?.classification !== "synthetic/planned" ||
      snapshot.planned_aic.per_wave !== 2000 || snapshot.planned_aic.total !== 6000 ||
      snapshot.planned_aic.observed_model_use !== 0) {
    throw new Error("Synthetic proof snapshot identity, capacity, or AIC labeling is invalid");
  }
  assertPositiveUniqueIds("snapshot ordered issue IDs", snapshot.ordered_issue_ids);
  if (snapshot.ordered_issue_ids.length !== 25 ||
      JSON.stringify(snapshot.ordered_issue_ids) !== JSON.stringify(Array.from({ length: 25 }, (_, index) => index + 1001))) {
    throw new Error("Synthetic proof snapshot must contain the immutable ordered IDs 1001 through 1025");
  }
};
const validateCheckpoint = (checkpoint, snapshot) => {
  assertRecordedDigest("checkpoint", checkpoint, "checkpoint_digest");
  if (checkpoint.schema_version !== "backlog-grooming-multi-wave-proof-checkpoint/v1" ||
      checkpoint.proof_id !== snapshot.proof_id || checkpoint.scenario !== snapshot.scenario ||
      checkpoint.snapshot_digest !== snapshot.snapshot_digest || checkpoint.source_sha !== snapshot.source_sha ||
      checkpoint.required_waves !== 3 || checkpoint.wave_number < 1 || checkpoint.wave_number > 3 ||
      checkpoint.remaining_count !== 25 - checkpoint.cumulative_covered_count ||
      checkpoint.sweep_complete !== (checkpoint.cumulative_covered_count === 25)) {
    throw new Error("Proof checkpoint identity or transition is invalid");
  }
  assertPositiveUniqueIds("checkpoint assessed issue IDs", checkpoint.assessed_issue_ids);
  if (checkpoint.deferred_issue_ids.length !== 0) throw new Error("Synthetic proof checkpoints cannot defer fixtures");
};

const rowForIssue = (issue) => ({
  issue,
  title: `Synthetic proof issue ${issue}`,
  selection_reason: "Synthetic deterministic partition",
  activity_and_ownership_context: "Proof-only fixture; no issue was read or mutated",
  acceptance_signals: "Exercise exact multi-wave reduction",
  repository_evidence: ["Synthetic proof fixture"],
  lineage_evidence: { original_delivery: [], replacement_or_removal: [] },
  similarity_outcome: "Distinct",
  disposition: "Still needed",
  grooming_finding: "Synthetic assessed row",
  recommended_next_step: "No repository mutation",
  assessment_status: "Assessed",
});
const buildResult = (manifest, shard, ordinal) => {
  const material = {
    schema_version: "backlog-grooming-shard-result/v1",
    run_id: String(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    shard_id: shard.shard_id,
    manifest_digest: manifest.manifest_digest,
    ordered_candidate_ids: shard.ordered_candidate_ids,
    producer: "backlog-groom/result-job",
    started_at: `2026-08-18T00:0${ordinal}:00.000Z`,
    completed_at: `2026-08-18T00:0${ordinal}:01.000Z`,
    report_data: {
      run: {
        timestamp: `2026-08-18T00:0${ordinal}:01.000Z`,
        total_open_inventory: 25,
        assessed: shard.ordered_candidate_ids.length,
        priority_cohort: 0,
        round_robin_cohort: shard.ordered_candidate_ids.length,
        deferred: 0,
        stop_reason: "Synthetic proof fixture; zero model execution",
        next_cursor: shard.ordered_candidate_ids.at(-1),
      },
      issues: shard.ordered_candidate_ids.map(rowForIssue),
    },
  };
  return withDigest(material, "result_digest");
};

const prepare = () => {
  fs.rmSync(PROOF_ROOT, { recursive: true, force: true });
  const scenario = input("PROOF_SCENARIO");
  const continuationMode = input("PROOF_CONTINUATION_MODE", "initial");
  const requestedProofId = input("PROOF_ID");
  const waveNumber = integer("wave-number", input("PROOF_WAVE_NUMBER", "1"), 1, 3);
  if (!new Set(["complete-three-wave", "duplicate-dispatch", "failed-wave-resume"]).has(scenario) ||
      input("PROOF_PROTOCOL_VERSION") !== PROTOCOL_VERSION) {
    throw new Error("Unknown proof scenario or continuation protocol version");
  }
  const tuple = [
    input("PROOF_SNAPSHOT_RUN_ID"), input("PROOF_SNAPSHOT_ARTIFACT_ID"), input("PROOF_SNAPSHOT_DIGEST"),
    input("PROOF_CHECKPOINT_RUN_ID"), input("PROOF_CHECKPOINT_ARTIFACT_ID"), input("PROOF_CHECKPOINT_DIGEST"),
  ];
  const populated = tuple.filter(Boolean).length;
  const continuation = requestedProofId !== "" || populated !== 0;
  if ((!continuation && (waveNumber !== 1 || continuationMode !== "initial" || populated !== 0)) ||
      (continuation && (!requestedProofId || populated !== tuple.length || waveNumber < 2 ||
       process.env.GITHUB_ACTOR !== "github-actions[bot]"))) {
    throw new Error("Proof continuation identity must be complete, bounded, and dispatched by github-actions[bot]");
  }

  let snapshot;
  let prior = null;
  let proofId = requestedProofId;
  let snapshotRunId = input("PROOF_SNAPSHOT_RUN_ID");
  let snapshotArtifactId = input("PROOF_SNAPSHOT_ARTIFACT_ID");
  if (!continuation) {
    const capturedAt = new Date().toISOString();
    const identity = {
      repository_id: process.env.GITHUB_REPOSITORY_ID,
      repository: process.env.GITHUB_REPOSITORY,
      scenario,
      source_sha: process.env.GITHUB_SHA,
      initiating_run_id: String(process.env.GITHUB_RUN_ID),
      initiating_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      captured_at: capturedAt,
    };
    proofId = digest(identity);
    const material = {
      schema_version: "backlog-grooming-multi-wave-proof-snapshot/v1",
      protocol_version: PROTOCOL_VERSION,
      proof_id: proofId,
      scenario,
      repository_id: process.env.GITHUB_REPOSITORY_ID,
      repository: process.env.GITHUB_REPOSITORY,
      workflow_path: WORKFLOW_PATH,
      source_ref: process.env.GITHUB_REF,
      source_sha: process.env.GITHUB_SHA,
      initiating_run_id: String(process.env.GITHUB_RUN_ID),
      initiating_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      captured_at: capturedAt,
      ordered_issue_ids: Array.from({ length: 25 }, (_, index) => index + 1001),
      total_snapshot_count: 25,
      shard_count: 2,
      shard_width: 5,
      wave_capacity: 10,
      required_waves: 3,
      planned_aic: {
        classification: "synthetic/planned",
        per_worker: 1000,
        per_wave: 2000,
        total: 6000,
        observed_model_use: 0,
      },
    };
    snapshot = withDigest(material, "snapshot_digest");
    snapshotRunId = String(process.env.GITHUB_RUN_ID);
    writeJson(`${PROOF_ROOT}/snapshot/snapshot.json`, snapshot);
  } else {
    const snapshotName = artifactName(proofId, "snapshot", null, snapshotRunId);
    downloadArtifact(snapshotArtifactId, `${PROOF_ROOT}/snapshot`, {
      name: snapshotName,
      runId: snapshotRunId,
      sourceSha: process.env.GITHUB_SHA,
    });
    snapshot = readJson(`${PROOF_ROOT}/snapshot/snapshot.json`);
    validateSnapshot(snapshot);
    if (snapshot.proof_id !== proofId || snapshot.scenario !== scenario ||
        snapshot.snapshot_digest !== input("PROOF_SNAPSHOT_DIGEST")) {
      throw new Error("Continuation snapshot tuple does not match the immutable proof snapshot");
    }
    const priorRunId = input("PROOF_CHECKPOINT_RUN_ID");
    const priorArtifactId = input("PROOF_CHECKPOINT_ARTIFACT_ID");
    downloadArtifact(priorArtifactId, `${PROOF_ROOT}/prior`, {
      name: artifactName(proofId, "checkpoint", waveNumber - 1, priorRunId),
      runId: priorRunId,
      sourceSha: snapshot.source_sha,
    });
    prior = readJson(`${PROOF_ROOT}/prior/checkpoint.json`);
    validateCheckpoint(prior, snapshot);
    if (prior.checkpoint_digest !== input("PROOF_CHECKPOINT_DIGEST") ||
        prior.wave_number + 1 !== waveNumber || prior.sweep_complete) {
      throw new Error("Continuation checkpoint tuple does not match its accepted predecessor");
    }

    const accepted = findArtifacts(
      listProofArtifacts(proofId),
      `${ARTIFACT_PREFIX}-${proofId}-checkpoint-${waveNumber}-`,
    );
    if (accepted.length > 1) throw new Error("Multiple accepted proof checkpoints exist for one wave identity");
    if (accepted.length === 1) {
      const acceptedRunId = String(accepted[0].workflow_run?.id ?? "");
      downloadArtifact(accepted[0].id, `${PROOF_ROOT}/accepted`, {
        name: artifactName(proofId, "checkpoint", waveNumber, acceptedRunId),
        runId: acceptedRunId,
        sourceSha: snapshot.source_sha,
      });
      const checkpoint = readJson(`${PROOF_ROOT}/accepted/checkpoint.json`);
      validateCheckpoint(checkpoint, snapshot);
      if (checkpoint.prior_checkpoint_digest !== prior.checkpoint_digest) {
        throw new Error("Accepted duplicate checkpoint does not match the dispatched predecessor identity");
      }
      const noopMaterial = {
        schema_version: "backlog-grooming-multi-wave-proof-duplicate-noop/v1",
        proof_id: proofId,
        scenario,
        wave_number: waveNumber,
        source_run_id: String(process.env.GITHUB_RUN_ID),
        source_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        source_sha: snapshot.source_sha,
        accepted_checkpoint_run_id: checkpoint.source_run_id,
        accepted_checkpoint_artifact_id: String(accepted[0].id),
        accepted_checkpoint_digest: checkpoint.checkpoint_digest,
        predecessor_checkpoint_digest: prior.checkpoint_digest,
        fixture_created: false,
        validator_invoked: false,
        checkpoint_created: false,
        successor_dispatched: false,
      };
      writeJson(`${PROOF_ROOT}/duplicate-noop/duplicate-noop.json`, withDigest(noopMaterial, "noop_digest"));
      output("mode", "duplicate-noop");
      output("proof-id", proofId);
      output("wave-number", String(waveNumber));
      output("snapshot-run-id", snapshotRunId);
      output("snapshot-artifact-id", snapshotArtifactId);
      output("snapshot-digest", snapshot.snapshot_digest);
      return;
    }
  }
  validateSnapshot(snapshot);

  const allowedMode = scenario === "failed-wave-resume" && waveNumber === 2
    ? new Set(["injection", "recovery"])
    : new Set([continuation ? "ordinary" : "initial"]);
  if (!allowedMode.has(continuationMode)) throw new Error("Continuation mode is not valid for this proof wave");
  const start = (waveNumber - 1) * 10;
  const waveIds = snapshot.ordered_issue_ids.slice(start, start + 10);
  const shards = [0, 1].map((index) => ({
    shard_id: `shard-0${index + 1}`,
    ordered_candidate_ids: waveIds.filter((_, issueIndex) => issueIndex % 2 === index),
    priority_candidate_ids: [],
    round_robin_candidate_ids: waveIds.filter((_, issueIndex) => issueIndex % 2 === index),
    total_open_inventory: 25,
    prior_cursor: 0,
    worker_timeout_minutes: 20,
  })).filter((shard) => shard.ordered_candidate_ids.length > 0);
  const manifestMaterial = {
    schema_version: "backlog-grooming-wave-manifest/v1",
    sweep_id: proofId,
    snapshot_digest: snapshot.snapshot_digest,
    wave_number: waveNumber,
    required_waves: 3,
    prior_checkpoint_run_id: prior?.source_run_id ?? null,
    prior_checkpoint_artifact_id: input("PROOF_CHECKPOINT_ARTIFACT_ID") || null,
    prior_checkpoint_digest: prior?.checkpoint_digest ?? null,
    ordered_issue_ids: waveIds,
    planned_aic: 2000,
    run_id: String(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    shards,
  };
  const manifest = withDigest(manifestMaterial, "manifest_digest");
  writeJson(`${PROOF_ROOT}/manifest/manifest.json`, manifest);
  const results = shards.map((shard, index) => buildResult(manifest, shard, index + 1));
  results.forEach((result) => writeJson(
    `${PROOF_ROOT}/results/${result.shard_id}/shard-result.json`,
    result,
  ));
  if (continuationMode === "injection") {
    const conflict = JSON.parse(JSON.stringify(results[0]));
    conflict.report_data.run.stop_reason = AUTHORIZED_CONFLICT_STOP_REASON;
    conflict.result_digest = digest(withoutDigest(conflict, "result_digest"));
    writeJson(`${PROOF_ROOT}/results/conflict/shard-result.json`, conflict);
  }
  const fixtureMaterial = {
    schema_version: "backlog-grooming-multi-wave-proof-fixtures/v1",
    proof_id: proofId,
    scenario,
    wave_number: waveNumber,
    source_run_id: String(process.env.GITHUB_RUN_ID),
    source_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    source_sha: snapshot.source_sha,
    manifest_digest: manifest.manifest_digest,
    result_digests: results.map((result) => result.result_digest).sort(),
    injected_conflict: continuationMode === "injection",
    model_execution: "none",
    observed_model_use: 0,
  };
  const fixtureMetadata = withDigest(fixtureMaterial, "fixture_digest");
  writeJson(`${PROOF_ROOT}/results/fixture-metadata.json`, fixtureMetadata);

  output("mode", continuationMode === "injection" ? "injection" : "wave");
  output("proof-id", proofId);
  output("wave-number", String(waveNumber));
  output("snapshot-run-id", snapshotRunId);
  output("snapshot-artifact-id", snapshotArtifactId);
  output("snapshot-digest", snapshot.snapshot_digest);
  output("manifest-digest", manifest.manifest_digest);
  output("fixture-digest", fixtureMetadata.fixture_digest);
  output("prior-checkpoint-run-id", prior?.source_run_id ?? "");
  output("prior-checkpoint-artifact-id", input("PROOF_CHECKPOINT_ARTIFACT_ID"));
  output("prior-checkpoint-digest", prior?.checkpoint_digest ?? "");
  output("source-ref-name", snapshot.source_ref.replace(/^refs\/(heads|tags)\//, ""));
};

const checkValidation = () => {
  const mode = input("PROOF_MODE");
  const outcome = input("PROOF_VALIDATION_OUTCOME");
  const aggregateExists = fs.existsSync(`${PROOF_ROOT}/aggregate`);
  if (mode === "injection") {
    if (outcome !== "failure" || aggregateExists) {
      throw new Error("Injected conflict did not fail closed before aggregate creation");
    }
    const manifestPath = `${PROOF_ROOT}/manifest/manifest.json`;
    const manifest = readJson(manifestPath);
    const fixtureMetadata = readJson(`${PROOF_ROOT}/results/fixture-metadata.json`);
    const authenticated = validateInjectedConflictFixture(
      manifest,
      fixtureMetadata,
      readFixtureResults(`${PROOF_ROOT}/results`),
      {
        proofId: input("PROOF_ID"),
        runId: String(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        sourceSha: process.env.GITHUB_SHA,
        manifestDigest: input("PROOF_MANIFEST_DIGEST"),
        fixtureDigest: input("PROOF_FIXTURE_DIGEST"),
      },
    );
    const controlAggregate = runProductionControl(
      manifestPath,
      manifest,
      authenticated.originals,
      `${PROOF_ROOT}/control-results`,
      `${PROOF_ROOT}/control-aggregate`,
    );
    if (fs.existsSync(`${PROOF_ROOT}/aggregate`)) {
      throw new Error("Injected validator aggregate directory appeared during baseline control validation");
    }
    const material = {
      schema_version: "backlog-grooming-multi-wave-proof-rejection/v1",
      proof_id: input("PROOF_ID"),
      scenario: input("PROOF_SCENARIO"),
      wave_number: integer("wave-number", input("PROOF_WAVE_NUMBER"), 2, 2),
      source_run_id: String(process.env.GITHUB_RUN_ID),
      source_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      source_sha: process.env.GITHUB_SHA,
      manifest_artifact_id: input("PROOF_MANIFEST_ARTIFACT_ID"),
      manifest_digest: input("PROOF_MANIFEST_DIGEST"),
      fixture_artifact_id: input("PROOF_FIXTURE_ARTIFACT_ID"),
      fixture_digest: input("PROOF_FIXTURE_DIGEST"),
      prior_checkpoint_digest: input("PROOF_PRIOR_CHECKPOINT_DIGEST"),
      validator: ".github/actions/backlog-groom-wave-validator/validate.js",
      validation_outcome: "failure",
      rejection_reason: REJECTION_REASON,
      baseline_control_accepted: true,
      injected_conflict_authenticated: true,
      original_result_digest: authenticated.original.result_digest,
      conflicting_result_digest: authenticated.conflict.result_digest,
      control_aggregate_digest: controlAggregate.aggregate_digest,
      aggregate_created: false,
      checkpoint_created: false,
      ordinary_successor_dispatched: false,
    };
    writeJson(`${PROOF_ROOT}/rejection/rejection.json`, withDigest(material, "rejection_digest"));
    output("dispatch-kind", "recovery");
    return;
  }
  if (outcome !== "success" || !aggregateExists) {
    throw new Error("Shared production validator did not accept the exact synthetic wave fixture set");
  }
  output("dispatch-kind", "ordinary");
};

const waitDuplicateNoop = () => {
  const proofId = input("PROOF_ID");
  const waveNumber = integer("wave-number", input("PROOF_WAVE_NUMBER"), 2, 2);
  let matches = [];
  for (let attempt = 0; attempt < DISCOVERY_WAIT_ATTEMPTS; attempt += 1) {
    matches = findArtifacts(
      listProofArtifacts(proofId),
      `${ARTIFACT_PREFIX}-${proofId}-duplicate-noop-${waveNumber}-`,
    );
    if (matches.length > 1) throw new Error("Multiple duplicate no-op artifacts exist for one proof wave identity");
    if (matches.length === 1) break;
    wait(5000);
  }
  if (matches.length !== 1) throw new Error("Duplicate proof run did not emit one bounded no-op artifact");
  const artifact = matches[0];
  const runId = String(artifact.workflow_run?.id ?? "");
  const entry = readAuthenticatedArtifact(
    artifact,
    `${PROOF_ROOT}/observed-duplicate-noop`,
    artifactName(proofId, "duplicate-noop", waveNumber, runId),
    runId,
    process.env.GITHUB_SHA,
    "duplicate-noop.json",
  );
  validateDuplicateNoop(entry.value, {
    proofId,
    waveNumber,
    sourceRunId: runId,
    sourceAttempt: Number(entry.metadata.run.run_attempt),
    sourceSha: process.env.GITHUB_SHA,
    acceptedCheckpointRunId: input("PROOF_CHECKPOINT_RUN_ID"),
    acceptedCheckpointArtifactId: input("PROOF_CHECKPOINT_ARTIFACT_ID"),
    acceptedCheckpointDigest: input("PROOF_CHECKPOINT_DIGEST"),
    predecessorCheckpointDigest: input("PROOF_PRIOR_CHECKPOINT_DIGEST"),
  });
  if (!/^sha256:[a-f0-9]{64}$/.test(entry.metadata.artifact.digest)) {
    throw new Error("Duplicate no-op artifact digest is unavailable or malformed");
  }
  output("duplicate-noop-artifact-id", String(artifact.id));
  output("duplicate-noop-artifact-digest", entry.metadata.artifact.digest);
  output("duplicate-noop-run-id", runId);
  output("duplicate-noop-digest", entry.value.noop_digest);
};

const checkpoint = () => {
  const snapshot = readJson(`${PROOF_ROOT}/snapshot/snapshot.json`);
  const manifest = readJson(`${PROOF_ROOT}/manifest/manifest.json`);
  const aggregate = readJson(`${PROOF_ROOT}/aggregate/aggregate.json`);
  validateSnapshot(snapshot);
  assertRecordedDigest("manifest", manifest, "manifest_digest");
  assertRecordedDigest("aggregate", aggregate, "aggregate_digest");
  const waveNumber = manifest.wave_number;
  const expectedIds = snapshot.ordered_issue_ids.slice((waveNumber - 1) * 10, waveNumber * 10);
  const aggregateIds = [...aggregate.assessed_issue_ids, ...aggregate.deferred_issue_ids].sort((a, b) => a - b);
  if (manifest.run_id !== String(process.env.GITHUB_RUN_ID) || aggregate.source_run_id !== String(process.env.GITHUB_RUN_ID) ||
      aggregate.manifest_digest !== manifest.manifest_digest || aggregate.aggregate_digest !== input("PROOF_AGGREGATE_DIGEST") ||
      JSON.stringify(expectedIds) !== JSON.stringify(aggregateIds) ||
      JSON.stringify(expectedIds) !== JSON.stringify(aggregate.rows.map((row) => row.issue))) {
    throw new Error("Accepted proof aggregate does not exactly cover its immutable wave partition");
  }
  let prior = null;
  if (waveNumber > 1) {
    prior = readJson(`${PROOF_ROOT}/prior/checkpoint.json`);
    validateCheckpoint(prior, snapshot);
    if (prior.checkpoint_digest !== input("PROOF_PRIOR_CHECKPOINT_DIGEST") || prior.wave_number + 1 !== waveNumber) {
      throw new Error("Proof checkpoint predecessor changed before checkpoint creation");
    }
  }
  const cumulativeCoveredCount = (prior?.cumulative_covered_count ?? 0) + aggregateIds.length;
  const material = {
    schema_version: "backlog-grooming-multi-wave-proof-checkpoint/v1",
    proof_id: snapshot.proof_id,
    scenario: snapshot.scenario,
    snapshot_digest: snapshot.snapshot_digest,
    wave_number: waveNumber,
    required_waves: 3,
    source_run_id: String(process.env.GITHUB_RUN_ID),
    source_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    source_sha: snapshot.source_sha,
    source_manifest_artifact_id: input("PROOF_MANIFEST_ARTIFACT_ID"),
    source_manifest_digest: manifest.manifest_digest,
    source_fixture_artifact_id: input("PROOF_FIXTURE_ARTIFACT_ID"),
    source_fixture_digest: input("PROOF_FIXTURE_DIGEST"),
    source_aggregate_artifact_id: input("PROOF_AGGREGATE_ARTIFACT_ID"),
    source_aggregate_digest: aggregate.aggregate_digest,
    prior_checkpoint_run_id: prior?.source_run_id ?? null,
    prior_checkpoint_artifact_id: input("PROOF_PRIOR_CHECKPOINT_ARTIFACT_ID") || null,
    prior_checkpoint_digest: prior?.checkpoint_digest ?? null,
    assessed_issue_ids: aggregate.assessed_issue_ids,
    deferred_issue_ids: aggregate.deferred_issue_ids,
    cumulative_covered_count: cumulativeCoveredCount,
    cumulative_digest: digest({
      prior: prior?.cumulative_digest ?? null,
      wave_number: waveNumber,
      assessed_issue_ids: aggregate.assessed_issue_ids,
      deferred_issue_ids: aggregate.deferred_issue_ids,
    }),
    remaining_count: 25 - cumulativeCoveredCount,
    sweep_complete: cumulativeCoveredCount === 25,
    completed_at: new Date().toISOString(),
  };
  const accepted = withDigest(material, "checkpoint_digest");
  validateCheckpoint(accepted, snapshot);
  writeJson(`${PROOF_ROOT}/checkpoint/checkpoint.json`, accepted);
  output("checkpoint-digest", accepted.checkpoint_digest);
  output("sweep-complete", String(accepted.sweep_complete));
  output("dispatch-kind", accepted.sweep_complete ? "none" : "ordinary");
};

const readAuthenticatedArtifact = (artifact, destination, expectedName, expectedRunId, sourceSha, fileName) => {
  const metadata = downloadArtifact(artifact.id, destination, {
    name: expectedName,
    runId: expectedRunId,
    sourceSha,
  });
  return { value: readJson(path.join(destination, fileName)), metadata };
};
const findExactArtifact = (artifacts, name) => {
  const matches = artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1) throw new Error(`Expected one authenticated artifact named ${name}, found ${matches.length}`);
  return matches[0];
};

const finalize = () => {
  const proofId = input("PROOF_ID");
  let artifacts = listProofArtifacts(proofId);
  const snapshotRunId = input("PROOF_SNAPSHOT_RUN_ID");
  const snapshotArtifact = findExactArtifact(
    artifacts,
    artifactName(proofId, "snapshot", null, snapshotRunId),
  );
  const snapshotEntry = readAuthenticatedArtifact(
    snapshotArtifact,
    `${PROOF_ROOT}/terminal/snapshot`,
    snapshotArtifact.name,
    snapshotRunId,
    process.env.GITHUB_SHA,
    "snapshot.json",
  );
  const snapshot = snapshotEntry.value;
  validateSnapshot(snapshot);
  const checkpointArtifacts = findArtifacts(artifacts, `${ARTIFACT_PREFIX}-${proofId}-checkpoint-`);
  if (checkpointArtifacts.length !== 3) throw new Error("Terminal proof requires exactly three accepted checkpoints");
  const checkpoints = [];
  const aggregates = [];
  const artifactLedger = [];
  for (let wave = 1; wave <= 3; wave += 1) {
    const candidates = checkpointArtifacts.filter((artifact) => artifact.name.includes(`-checkpoint-${wave}-`));
    if (candidates.length !== 1) throw new Error(`Wave ${wave} must have exactly one accepted checkpoint`);
    const runId = String(candidates[0].workflow_run?.id ?? "");
    const checkpointEntry = readAuthenticatedArtifact(
      candidates[0],
      `${PROOF_ROOT}/terminal/checkpoint-${wave}`,
      artifactName(proofId, "checkpoint", wave, runId),
      runId,
      snapshot.source_sha,
      "checkpoint.json",
    );
    const current = checkpointEntry.value;
    validateCheckpoint(current, snapshot);
    if (current.wave_number !== wave || current.prior_checkpoint_digest !== (checkpoints.at(-1)?.checkpoint_digest ?? null) ||
        current.prior_checkpoint_artifact_id !== (checkpoints.length ? String(checkpointArtifacts.find(
          (artifact) => artifact.name.includes(`-checkpoint-${wave - 1}-`),
        ).id) : null)) {
      throw new Error("Terminal checkpoint ledger is reordered or predecessor-bound incorrectly");
    }
    const expectedNames = {
      manifest: artifactName(proofId, "manifest", wave, runId),
      fixtures: artifactName(proofId, "fixtures", wave, runId),
      aggregate: artifactName(proofId, "aggregate", wave, runId),
    };
    const manifestArtifact = findExactArtifact(artifacts, expectedNames.manifest);
    const fixtureArtifact = findExactArtifact(artifacts, expectedNames.fixtures);
    const aggregateArtifact = findExactArtifact(artifacts, expectedNames.aggregate);
    if (String(manifestArtifact.id) !== current.source_manifest_artifact_id ||
        String(fixtureArtifact.id) !== current.source_fixture_artifact_id ||
        String(aggregateArtifact.id) !== current.source_aggregate_artifact_id) {
      throw new Error("Checkpoint artifact IDs do not match the authenticated terminal ledger");
    }
    const manifestEntry = readAuthenticatedArtifact(
      manifestArtifact, `${PROOF_ROOT}/terminal/manifest-${wave}`, expectedNames.manifest,
      runId, snapshot.source_sha, "manifest.json",
    );
    const fixtureEntry = readAuthenticatedArtifact(
      fixtureArtifact, `${PROOF_ROOT}/terminal/fixtures-${wave}`, expectedNames.fixtures,
      runId, snapshot.source_sha, "fixture-metadata.json",
    );
    const aggregateEntry = readAuthenticatedArtifact(
      aggregateArtifact, `${PROOF_ROOT}/terminal/aggregate-${wave}`, expectedNames.aggregate,
      runId, snapshot.source_sha, "aggregate.json",
    );
    const manifest = manifestEntry.value;
    const fixtures = fixtureEntry.value;
    const aggregate = aggregateEntry.value;
    assertRecordedDigest("terminal manifest", manifest, "manifest_digest");
    assertRecordedDigest("terminal fixtures", fixtures, "fixture_digest");
    assertRecordedDigest("terminal aggregate", aggregate, "aggregate_digest");
    if (manifest.manifest_digest !== current.source_manifest_digest ||
        fixtures.fixture_digest !== current.source_fixture_digest ||
        aggregate.aggregate_digest !== current.source_aggregate_digest ||
        aggregate.manifest_digest !== manifest.manifest_digest || fixtures.observed_model_use !== 0) {
      throw new Error("Terminal manifest, fixture, or aggregate digest binding failed");
    }
    checkpoints.push(current);
    aggregates.push(aggregate);
    artifactLedger.push({
      wave_number: wave,
      run_id: runId,
      checkpoint_artifact_id: String(candidates[0].id),
      checkpoint_artifact_digest: checkpointEntry.metadata.artifact.digest,
      checkpoint_digest: current.checkpoint_digest,
      manifest_artifact_id: String(manifestArtifact.id),
      manifest_artifact_digest: manifestEntry.metadata.artifact.digest,
      fixture_artifact_id: String(fixtureArtifact.id),
      fixture_artifact_digest: fixtureEntry.metadata.artifact.digest,
      aggregate_artifact_id: String(aggregateArtifact.id),
      aggregate_artifact_digest: aggregateEntry.metadata.artifact.digest,
    });
  }
  if (new Set(checkpoints.map((item) => item.source_run_id)).size !== 3 || !checkpoints[2].sweep_complete) {
    throw new Error("Complete proof requires three distinct accepted run IDs and a terminal checkpoint");
  }
  const rows = aggregates.flatMap((aggregate) => aggregate.rows);
  if (JSON.stringify(rows.map((row) => row.issue)) !== JSON.stringify(snapshot.ordered_issue_ids) ||
      new Set(rows.map((row) => row.issue)).size !== 25) {
    throw new Error("Terminal proof reduction is not the exact immutable 25-ID snapshot");
  }

  const expectedDispatchCount = snapshot.scenario === "failed-wave-resume" ? 3 : 2;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    artifacts = listProofArtifacts(proofId);
    if (findArtifacts(artifacts, `${ARTIFACT_PREFIX}-${proofId}-dispatch-`).length >= expectedDispatchCount) break;
    wait(5000);
  }
  const noops = findArtifacts(artifacts, `${ARTIFACT_PREFIX}-${proofId}-duplicate-noop-`);
  const rejections = findArtifacts(artifacts, `${ARTIFACT_PREFIX}-${proofId}-rejection-2-`);
  const dispatches = findArtifacts(artifacts, `${ARTIFACT_PREFIX}-${proofId}-dispatch-`);
  const dispatchEvidence = dispatches.map((artifact, index) => {
    const runId = String(artifact.workflow_run?.id ?? "");
    const entry = readAuthenticatedArtifact(
      artifact, `${PROOF_ROOT}/terminal/dispatch-${index}`,
      artifact.name, runId, snapshot.source_sha, "dispatch-record.json",
    );
    assertRecordedDigest("dispatch record", entry.value, "dispatch_digest");
    return {
      artifact_id: String(artifact.id),
      artifact_digest: entry.metadata.artifact.digest,
      record: entry.value,
    };
  });
  const dispatchRecords = dispatchEvidence.map((entry) => entry.record);
  const assertions = {
    manual_only: true,
    zero_model_execution: aggregates.every((aggregate) => aggregate.rows.length > 0) &&
      snapshot.planned_aic.observed_model_use === 0,
    exact_snapshot_reduction: true,
    accepted_checkpoint_count: checkpoints.length,
    distinct_accepted_run_count: new Set(checkpoints.map((item) => item.source_run_id)).size,
    terminal_has_no_successor: dispatchRecords.every((record) => record.source_run_id !== checkpoints[2].source_run_id),
  };
  let scenarioEvidence = { dispatch_artifacts: dispatchEvidence };
  if (!assertions.terminal_has_no_successor) throw new Error("Terminal proof run emitted a successor dispatch");

  if (snapshot.scenario === "complete-three-wave") {
    if (noops.length !== 0 || rejections.length !== 0 || dispatchRecords.length !== 2) {
      throw new Error("Complete scenario ledger must contain two successors and no duplicate or rejection evidence");
    }
    assertions.complete_three_wave = true;
  } else if (snapshot.scenario === "duplicate-dispatch") {
    if (noops.length !== 1 || rejections.length !== 0 || dispatchRecords.length !== 2) {
      throw new Error("Duplicate scenario requires two dispatch ledgers and one no-op run");
    }
    const noopRunId = String(noops[0].workflow_run?.id ?? "");
    const noopEntry = readAuthenticatedArtifact(
      noops[0], `${PROOF_ROOT}/terminal/duplicate-noop`, noops[0].name,
      noopRunId, snapshot.source_sha, "duplicate-noop.json",
    );
    const noop = noopEntry.value;
    const waveTwoDispatches = dispatchRecords.filter((record) => record.source_run_id === checkpoints[1].source_run_id);
    validateDuplicateNoop(noop, {
      proofId,
      waveNumber: 2,
      sourceRunId: noopRunId,
      sourceAttempt: Number(noopEntry.metadata.run.run_attempt),
      sourceSha: snapshot.source_sha,
      acceptedCheckpointRunId: checkpoints[1].source_run_id,
      acceptedCheckpointArtifactId: artifactLedger[1].checkpoint_artifact_id,
      acceptedCheckpointDigest: checkpoints[1].checkpoint_digest,
      predecessorCheckpointDigest: checkpoints[0].checkpoint_digest,
    });
    if (
        waveTwoDispatches.length !== 1 ||
        waveTwoDispatches[0].requests.filter((request) => request.kind === "duplicate").length !== 1 ||
        waveTwoDispatches[0].requests.filter((request) => request.kind === "ordinary").length !== 1 ||
        waveTwoDispatches[0].requests[0].observed_noop_artifact_id !== String(noops[0].id) ||
        waveTwoDispatches[0].requests[0].observed_noop_artifact_digest !== noopEntry.metadata.artifact.digest ||
        waveTwoDispatches[0].requests[0].observed_noop_run_id !== noopRunId ||
        waveTwoDispatches[0].requests[0].observed_noop_digest !== noop.noop_digest ||
        checkpoints.some((item) => item.source_run_id === noopRunId)) {
      throw new Error("Duplicate dispatch did not produce exactly one checkpoint, one no-op, and one ordinary successor");
    }
    assertions.duplicate_dispatch_noop = true;
    assertions.duplicate_run_id = noopRunId;
    scenarioEvidence = {
      ...scenarioEvidence,
      duplicate_noop_artifact_id: String(noops[0].id),
      duplicate_noop_artifact_digest: noopEntry.metadata.artifact.digest,
      duplicate_noop: noop,
    };
  } else {
    if (rejections.length !== 1 || noops.length !== 0 || dispatchRecords.length !== 3) {
      throw new Error("Failed-resume scenario requires three dispatch ledgers and one rejection");
    }
    const rejectedRunId = String(rejections[0].workflow_run?.id ?? "");
    const rejectionEntry = readAuthenticatedArtifact(
      rejections[0], `${PROOF_ROOT}/terminal/rejection`, rejections[0].name,
      rejectedRunId, snapshot.source_sha, "rejection.json",
    );
    const rejection = rejectionEntry.value;
    assertRecordedDigest("rejection", rejection, "rejection_digest");
    const rejectionManifestArtifact = findExactArtifact(
      artifacts,
      artifactName(proofId, "manifest", 2, rejectedRunId),
    );
    const rejectionFixtureArtifact = findExactArtifact(
      artifacts,
      artifactName(proofId, "fixtures", 2, rejectedRunId),
    );
    if (String(rejectionManifestArtifact.id) !== rejection.manifest_artifact_id ||
        String(rejectionFixtureArtifact.id) !== rejection.fixture_artifact_id) {
      throw new Error("Rejection evidence does not identify its exact manifest and fixture artifacts");
    }
    const rejectionManifestEntry = readAuthenticatedArtifact(
      rejectionManifestArtifact,
      `${PROOF_ROOT}/terminal/rejection-manifest`,
      rejectionManifestArtifact.name,
      rejectedRunId,
      snapshot.source_sha,
      "manifest.json",
    );
    const rejectionFixtureEntry = readAuthenticatedArtifact(
      rejectionFixtureArtifact,
      `${PROOF_ROOT}/terminal/rejection-fixtures`,
      rejectionFixtureArtifact.name,
      rejectedRunId,
      snapshot.source_sha,
      "fixture-metadata.json",
    );
    if (rejectionManifestEntry.value.manifest_digest !== rejection.manifest_digest ||
        rejectionFixtureEntry.value.fixture_digest !== rejection.fixture_digest) {
      throw new Error("Rejected manifest or fixture content digest does not match rejection evidence");
    }
    const authenticated = validateInjectedConflictFixture(
      rejectionManifestEntry.value,
      rejectionFixtureEntry.value,
      readFixtureResults(`${PROOF_ROOT}/terminal/rejection-fixtures`),
      {
        proofId,
        runId: rejectedRunId,
        attempt: rejection.source_attempt,
        sourceSha: snapshot.source_sha,
        manifestDigest: rejection.manifest_digest,
        fixtureDigest: rejection.fixture_digest,
      },
    );
    const controlAggregate = runProductionControl(
      `${PROOF_ROOT}/terminal/rejection-manifest/manifest.json`,
      rejectionManifestEntry.value,
      authenticated.originals,
      `${PROOF_ROOT}/terminal/rejection-control-results`,
      `${PROOF_ROOT}/terminal/rejection-control-aggregate`,
    );
    const failedAggregate = artifacts.some((artifact) => artifact.name === artifactName(
      proofId, "aggregate", 2, rejectedRunId,
    ));
    const failedCheckpoint = checkpoints.some((item) => item.source_run_id === rejectedRunId);
    if (rejection.rejection_reason?.code !== REJECTION_REASON.code ||
      rejection.rejection_reason?.message !== REJECTION_REASON.message ||
      rejection.validator !== ".github/actions/backlog-groom-wave-validator/validate.js" ||
      rejection.validation_outcome !== "failure" || rejection.baseline_control_accepted !== true ||
      rejection.injected_conflict_authenticated !== true ||
      rejection.original_result_digest !== authenticated.original.result_digest ||
      rejection.conflicting_result_digest !== authenticated.conflict.result_digest ||
      rejection.control_aggregate_digest !== controlAggregate.aggregate_digest ||
      rejection.source_run_id !== rejectedRunId ||
      rejection.source_attempt !== Number(rejectionEntry.metadata.run.run_attempt) ||
      rejection.source_sha !== snapshot.source_sha ||
      rejection.aggregate_created || rejection.checkpoint_created || rejection.ordinary_successor_dispatched ||
        failedAggregate || failedCheckpoint || rejection.prior_checkpoint_digest !== checkpoints[0].checkpoint_digest ||
        checkpoints[1].prior_checkpoint_digest !== checkpoints[0].checkpoint_digest ||
        !dispatchRecords.some((record) => record.requests.some((request) => request.kind === "recovery"))) {
      throw new Error("Failed wave emitted accepted state or recovery changed the prior checkpoint digest");
    }
    assertions.failed_wave_rejected_without_aggregate_or_checkpoint = true;
    assertions.recovery_preserved_prior_checkpoint_digest = true;
    assertions.rejected_run_id = rejectedRunId;
    scenarioEvidence = {
      ...scenarioEvidence,
      rejection_artifact_id: String(rejections[0].id),
      rejection_artifact_digest: rejectionEntry.metadata.artifact.digest,
      rejection,
      rejected_aggregate_artifact_found: failedAggregate,
      rejected_checkpoint_found: failedCheckpoint,
      preserved_prior_checkpoint_digest: checkpoints[0].checkpoint_digest,
    };
  }

  const finalMaterial = {
    schema_version: "backlog-grooming-multi-wave-proof-final/v1",
    proof_id: proofId,
    scenario: snapshot.scenario,
    snapshot_digest: snapshot.snapshot_digest,
    snapshot_artifact_id: String(snapshotArtifact.id),
    snapshot_artifact_digest: snapshotEntry.metadata.artifact.digest,
    source_sha: snapshot.source_sha,
    ordered_run_checkpoint_ledger: artifactLedger,
    checkpoint_digests: checkpoints.map((item) => item.checkpoint_digest),
    final_rows: rows,
    final_issue_ids: rows.map((row) => row.issue),
    assessed: rows.filter((row) => row.assessment_status === "Assessed").length,
    deferred: rows.filter((row) => row.assessment_status === "Deferred").length,
    planned_aic: snapshot.planned_aic,
    scenario_assertions: assertions,
    scenario_evidence: scenarioEvidence,
  };
  const finalEvidence = withDigest(finalMaterial, "final_digest");
  writeJson(`${PROOF_ROOT}/terminal-evidence/snapshot.json`, snapshot);
  writeJson(`${PROOF_ROOT}/terminal-evidence/ordered-ledger.json`, artifactLedger);
  writeJson(`${PROOF_ROOT}/terminal-evidence/final-rows.json`, rows);
  writeJson(`${PROOF_ROOT}/terminal-evidence/terminal-proof-evidence.json`, finalEvidence);
  output("final-digest", finalEvidence.final_digest);
};

const commands = {
  prepare,
  "check-validation": checkValidation,
  "wait-duplicate-noop": waitDuplicateNoop,
  checkpoint,
  finalize,
};

if (require.main === module) {
  const command = input("PROOF_COMMAND");
  if (!commands[command]) throw new Error(`Unknown proof helper command: ${command}`);
  commands[command]();
}

module.exports = {
  AUTHORIZED_CONFLICT_STOP_REASON,
  ORIGINAL_STOP_REASON,
  canonicalize,
  digest,
  expectedAggregate,
  validateControlAggregate,
  validateDiscoveredRuns,
  validateDuplicateNoop,
  validateInjectedConflictFixture,
  withDigest,
  withoutDigest,
};