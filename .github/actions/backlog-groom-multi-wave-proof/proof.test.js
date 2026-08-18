const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUTHORIZED_CONFLICT_STOP_REASON,
  ORIGINAL_STOP_REASON,
  expectedAggregate,
  validateControlAggregate,
  validateDiscoveredRuns,
  validateDuplicateNoop,
  validateInjectedConflictFixture,
  withDigest,
  withoutDigest,
  digest,
} = require("./proof.js");

const PROOF_ID = "a".repeat(64);
const SNAPSHOT_DIGEST = "b".repeat(64);
const SOURCE_SHA = "c".repeat(40);
const RUN_ID = "314";
const ATTEMPT = 2;

const row = (issue) => ({ issue, assessment_status: "Assessed" });

const result = (manifest, shard) => withDigest({
  schema_version: "backlog-grooming-shard-result/v1",
  run_id: RUN_ID,
  attempt: ATTEMPT,
  shard_id: shard.shard_id,
  manifest_digest: manifest.manifest_digest,
  ordered_candidate_ids: shard.ordered_candidate_ids,
  producer: "backlog-groom/result-job",
  started_at: "2026-08-18T00:00:00.000Z",
  completed_at: "2026-08-18T00:00:01.000Z",
  report_data: {
    run: { stop_reason: ORIGINAL_STOP_REASON },
    issues: shard.ordered_candidate_ids.map(row),
  },
}, "result_digest");

const buildInjectedFixture = () => {
  const shards = [
    { shard_id: "shard-01", ordered_candidate_ids: [1001, 1003] },
    { shard_id: "shard-02", ordered_candidate_ids: [1002, 1004] },
  ];
  const manifest = withDigest({
    schema_version: "backlog-grooming-wave-manifest/v1",
    sweep_id: PROOF_ID,
    snapshot_digest: SNAPSHOT_DIGEST,
    wave_number: 2,
    required_waves: 3,
    ordered_issue_ids: [1001, 1002, 1003, 1004],
    run_id: RUN_ID,
    attempt: ATTEMPT,
    shards,
  }, "manifest_digest");
  const originals = shards.map((shard) => result(manifest, shard));
  const conflict = structuredClone(originals[0]);
  conflict.report_data.run.stop_reason = AUTHORIZED_CONFLICT_STOP_REASON;
  conflict.result_digest = digest(withoutDigest(conflict, "result_digest"));
  const fixtureMetadata = withDigest({
    schema_version: "backlog-grooming-multi-wave-proof-fixtures/v1",
    proof_id: PROOF_ID,
    scenario: "failed-wave-resume",
    wave_number: 2,
    source_run_id: RUN_ID,
    source_attempt: ATTEMPT,
    source_sha: SOURCE_SHA,
    manifest_digest: manifest.manifest_digest,
    result_digests: originals.map((item) => item.result_digest).sort(),
    injected_conflict: true,
    model_execution: "none",
    observed_model_use: 0,
  }, "fixture_digest");
  const expected = {
    proofId: PROOF_ID,
    runId: RUN_ID,
    attempt: ATTEMPT,
    sourceSha: SOURCE_SHA,
    manifestDigest: manifest.manifest_digest,
    fixtureDigest: fixtureMetadata.fixture_digest,
  };
  return { manifest, originals, conflict, fixtureMetadata, expected };
};

const buildNoop = () => withDigest({
  schema_version: "backlog-grooming-multi-wave-proof-duplicate-noop/v1",
  proof_id: PROOF_ID,
  scenario: "duplicate-dispatch",
  wave_number: 2,
  source_run_id: "400",
  source_attempt: 1,
  source_sha: SOURCE_SHA,
  accepted_checkpoint_run_id: "350",
  accepted_checkpoint_artifact_id: "9001",
  accepted_checkpoint_digest: "d".repeat(64),
  predecessor_checkpoint_digest: "e".repeat(64),
  fixture_created: false,
  validator_invoked: false,
  checkpoint_created: false,
  successor_dispatched: false,
}, "noop_digest");

const noopExpected = {
  proofId: PROOF_ID,
  waveNumber: 2,
  sourceRunId: "400",
  sourceAttempt: 1,
  sourceSha: SOURCE_SHA,
  acceptedCheckpointRunId: "350",
  acceptedCheckpointArtifactId: "9001",
  acceptedCheckpointDigest: "d".repeat(64),
  predecessorCheckpointDigest: "e".repeat(64),
};

test("accepts only the authorized conflicting shard-result pair", () => {
  const fixture = buildInjectedFixture();
  const validated = validateInjectedConflictFixture(
    fixture.manifest,
    fixture.fixtureMetadata,
    [...fixture.originals, fixture.conflict],
    fixture.expected,
  );
  assert.equal(validated.original.result_digest, fixture.originals[0].result_digest);
  assert.equal(validated.conflict.result_digest, fixture.conflict.result_digest);
});

test("rejects unrelated or tampered conflicting failure fixtures", async (context) => {
  await context.test("rejects a re-digested mutation outside stop_reason", () => {
    const fixture = buildInjectedFixture();
    fixture.conflict.report_data.run.assessed = 99;
    fixture.conflict.result_digest = digest(withoutDigest(fixture.conflict, "result_digest"));
    assert.throws(() => validateInjectedConflictFixture(
      fixture.manifest,
      fixture.fixtureMetadata,
      [...fixture.originals, fixture.conflict],
      fixture.expected,
    ), /differs outside the authorized/);
  });

  await context.test("rejects fixture metadata rebound to another manifest", () => {
    const fixture = buildInjectedFixture();
    fixture.fixtureMetadata.manifest_digest = "f".repeat(64);
    fixture.fixtureMetadata.fixture_digest = digest(withoutDigest(fixture.fixtureMetadata, "fixture_digest"));
    assert.throws(() => validateInjectedConflictFixture(
      fixture.manifest,
      fixture.fixtureMetadata,
      [...fixture.originals, fixture.conflict],
      fixture.expected,
    ), /not bound to the exact failed wave manifest/);
  });

  await context.test("rejects an invalid recorded conflict digest", () => {
    const fixture = buildInjectedFixture();
    fixture.conflict.result_digest = "0".repeat(64);
    assert.throws(() => validateInjectedConflictFixture(
      fixture.manifest,
      fixture.fixtureMetadata,
      [...fixture.originals, fixture.conflict],
      fixture.expected,
    ), /digest mismatch/);
  });
});

test("requires exact baseline control aggregate digest and coverage", () => {
  const fixture = buildInjectedFixture();
  const aggregate = expectedAggregate(fixture.manifest, fixture.originals);
  assert.equal(validateControlAggregate(
    aggregate,
    fixture.manifest,
    fixture.originals,
  ).aggregate_digest, aggregate.aggregate_digest);

  const tampered = structuredClone(aggregate);
  tampered.assessed_issue_ids.pop();
  tampered.aggregate_digest = digest(withoutDigest(tampered, "aggregate_digest"));
  assert.throws(
    () => validateControlAggregate(tampered, fixture.manifest, fixture.originals),
    /digest or exact coverage is invalid/,
  );
});

test("authenticates duplicate no-op evidence and rejects tampering", async (context) => {
  assert.equal(validateDuplicateNoop(buildNoop(), noopExpected).wave_number, 2);

  await context.test("rejects a changed predecessor with a valid new digest", () => {
    const noop = buildNoop();
    noop.predecessor_checkpoint_digest = "0".repeat(64);
    noop.noop_digest = digest(withoutDigest(noop, "noop_digest"));
    assert.throws(() => validateDuplicateNoop(noop, noopExpected), /exact accepted checkpoint transition/);
  });

  await context.test("rejects an invalid recorded digest", () => {
    const noop = buildNoop();
    noop.noop_digest = "0".repeat(64);
    assert.throws(() => validateDuplicateNoop(noop, noopExpected), /digest mismatch/);
  });

  for (const flag of ["fixture_created", "validator_invoked", "checkpoint_created", "successor_dispatched"]) {
    await context.test(`rejects true ${flag}`, () => {
      const noop = buildNoop();
      noop[flag] = true;
      noop.noop_digest = digest(withoutDigest(noop, "noop_digest"));
      assert.throws(() => validateDuplicateNoop(noop, noopExpected), /exact accepted checkpoint transition/);
    });
  }
});

test("rejects workflow-run discovery outside the exact producer source SHA", () => {
  const valid = [{ path: ".github/workflows/backlog-groom-multi-wave-proof.yml", head_sha: SOURCE_SHA }];
  assert.deepEqual(validateDiscoveredRuns(valid, SOURCE_SHA), valid);
  assert.throws(
    () => validateDiscoveredRuns([{ ...valid[0], head_sha: "0".repeat(40) }], SOURCE_SHA),
    /unexpected producer/,
  );
  assert.throws(
    () => validateDiscoveredRuns(Array.from({ length: 100 }, () => valid[0]), SOURCE_SHA),
    /finite source-SHA limit/,
  );
});
