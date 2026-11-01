#!/usr/bin/env python3
"""Hosted-CI latency for the actual CLI. Each app version starts on its own fresh home."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import statistics
import subprocess
import sys
import time

OPERATIONS = ("get", "create", "update", "list", "search", "admin_slice")
SECRET_FIELDS = ("slug", "label", "provider", "purpose", "environment", "secret_value", "created_at", "updated_at")
SUMMARY_FIELDS = ("key", "payload_json", "updated_at")
# The metadata list rows of src/index-rows.ts: the root row, then 32 bucket rows.
# An app before the buckets writes only the root row.
SUMMARY_ROOT = "__all__"
SUMMARY_KEYS = (SUMMARY_ROOT,) + tuple(f"__bucket_{bucket:02d}__" for bucket in range(32))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def save(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def audit_output(output, records):
    require(output.is_dir() and not output.is_symlink(), "The retained output directory is absent or unsafe")
    files = []
    # Fixed depth two: the owned result files and one level of arm directories.
    for entry in output.iterdir():
        require(not entry.is_symlink(), "A retained path is a symlink")
        if entry.is_file():
            files.append(entry)
        else:
            require(entry.is_dir() and entry.name.startswith("pair-"), "An unexpected retained directory exists")
            for child in entry.iterdir():
                require(child.is_file() and not child.is_symlink(), "A nested retained path is not an ordinary file")
                files.append(child)
    require(files, "There is no measurement output to retain")
    prefixes = [value(index, generation)[:16].encode() for generation in (0, 1) for index in range(records * 2)]
    for path in files:
        require(path.stat().st_size <= 10 * 1024 * 1024, "A retained file exceeds the bounded review size")
        with path.open("rb") as stream:
            tail = b""
            while chunk := stream.read(1024 * 1024):
                combined = tail + chunk
                require(not any(prefix in combined for prefix in prefixes), "Generated value bytes appear in output; do not upload it")
                tail = combined[-15:]
    print(f"Retained output check passed for {len(files)} files. No generated value prefix appears.")


def value(index, generation=0):
    # Public generated workload bytes, never credentials from a user or service.
    return hashlib.sha256(f"lastsecrets-ci/{generation}/{index}".encode()).hexdigest() * 64


def slug(index):
    return f"ci-record-{index:06d}"


def cli_environment(node, config):
    environment = {name: item for name, item in os.environ.items()
                   if not name.startswith(("LASTDB", "FOLD", "LASTSECRETS", "SENTRY", "OBS_", "OTEL_"))
                   and name not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY")}
    environment.update(LASTSECRETS_CONFIG=str(config), LASTSECRETS_SOCKET_PATH=str(node.socket),
                       LASTDB_SUPPRESS_RECOVERY_PHRASE="1")
    return environment


def command(binary, node, config, verb, *arguments, payload=None, allow_failure=False, operation=None):
    if operation is not None:
        from process_counters import read_counters
        before = read_counters(node.process.pid)
        cpu_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter_ns()
    result = subprocess.run([str(binary), verb, *arguments, "--config", str(config)],
                            input=payload, text=True, capture_output=True,
                            env=cli_environment(node, config), timeout=120)
    elapsed = (time.perf_counter_ns() - started) / 1e6
    if operation is not None:
        cpu_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        after = read_counters(node.process.pid)
        observation = {"operation": operation, "elapsed_ms": elapsed,
            "waited_child_cpu_ms": 1000 * (cpu_after.ru_utime + cpu_after.ru_stime
                - cpu_before.ru_utime - cpu_before.ru_stime),
            "daemon_and_host": {"before": before, "after": after}}
        # No arguments, output, or generated value bytes enter this file.
        with (config.parent / "cli-observations.jsonl").open("a") as stream:
            stream.write(json.dumps(observation, sort_keys=True) + "\n")
    # CLI output can contain a generated value. Never copy it into an error or log.
    if result.returncode and verb == "init":
        # This control command never fetches value bytes. The output audit
        # still checks this file before any artifact upload.
        (config.parent / f"failed-{verb}.stderr").write_text(result.stderr)
    require(result.returncode == 0 or allow_failure, f"Actual CLI {verb} failed; no value is retained in this error")
    return result, elapsed


def put(binary, node, config, index, generation=0, operation=None):
    return command(binary, node, config, "put", slug(index), "--label", slug(index),
                   "--provider", "ci-example", "--purpose", "generated CI record", "--env", "ci",
                   "--value-stdin", payload=value(index, generation), operation=operation)[1]


def listed(text, expected):
    lines = [line for line in text.splitlines() if line]
    require(len(lines) == len(expected) and {line.split("\t")[0] for line in lines} == expected,
            "The complete metadata membership differs")
    require(all("value=<redacted>" in line for line in lines), "A metadata result lacks its redaction marker")


def schemas(config):
    cfg = json.loads(config.read_text())
    aliases = cfg.get("schemaFieldAliases", {})
    record_schema = cfg["schemaHash"] if cfg["schemaHash"] in aliases else cfg.get("schemaName", cfg["schemaHash"])
    summary = cfg["indexSchemaHash"] if cfg["indexSchemaHash"] in aliases else cfg.get("indexSchemaName", cfg["indexSchemaHash"])
    return aliases, record_schema, summary


def snapshot(node, config, expected, absent=()):
    aliases, record_schema, summary = schemas(config)
    requests = [(record_schema, key, SECRET_FIELDS) for key in expected] + [(summary, key, SUMMARY_FIELDS) for key in SUMMARY_KEYS]
    requests.extend((record_schema, key, SECRET_FIELDS) for key in absent)
    queries = [{"schema_name": schema, "fields": [aliases.get(schema, {}).get(field, field) for field in fields],
                "filter": {"HashKey": key}, "limit": 2, "offset": 0, "response_format":"full"} for schema, key, fields in requests]
    # A format 7 home stores records, not atoms. Its field metadata has an empty
    # atom_uuid and no molecule_uuid or writer_pubkey.
    record_home = node.record_home()
    atoms, members = {}, {}
    for start in range(0, len(queries), 64):
        reply = node.call("/api/queries/batch", {"queries": queries[start:start + 64]})[0]
        rows = reply.get("results")
        require(reply.get("count") == len(queries[start:start + 64]) and isinstance(rows, list), "The snapshot batch is incomplete")
        require(len(rows) == len(queries[start:start + 64]), "The snapshot batch count differs")
        for offset, item in enumerate(rows):
            query = queries[start + offset]
            response = item.get("response", {})
            result = response.get("results", [])
            require(item.get("status") == 200 and response.get("ok") is True
                    and response.get("has_more") is False and response.get("unresolved_rows") == 0,
                    "An exact known-key read is incomplete")
            key = query["filter"]["HashKey"]
            summary_row = query["schema_name"] == summary
            if key in absent and query["schema_name"] == record_schema:
                require(result == [], "A deleted key still returns a record")
                continue
            if summary_row and result == []:
                # A home has only the summary rows that an app wrote.
                continue
            require(len(result) == 1, "A known record is absent or ambiguous")
            row = result[0]
            require(row.get("key") == {"hash": key, "range": None}, "An exact read returned another key")
            fields, metadata = row.get("fields", {}), row.get("metadata", {})
            require(set(fields) == set(query["fields"]), "A known record lacks declared fields")
            if summary_row:
                name = aliases.get(summary, {}).get("payload_json", "payload_json")
                members[key] = sorted(item["slug"] for item in json.loads(fields[name]))
            else:
                name = aliases.get(record_schema, {}).get("secret_value", "secret_value")
                require(fields[name] == {"value": expected[key]}, "A complete generated value differs")
            for field in query["fields"]:
                info = metadata.get(field, {})
                atom = info.get("atom_uuid")
                require(isinstance(atom, str) and (record_home or atom), "A field lacks its current atom identity")
                # Reopen and repeated setup must keep current atoms and author metadata.
                atoms[f"{query['schema_name']}/{key}/{field}"] = {name: info.get(name)
                    for name in ("atom_uuid", "writer_pubkey", "metadata")}
    # Each known slug is in exactly one summary row.
    listed = [item for key in SUMMARY_KEYS for item in members.get(key, [])]
    require(len(listed) == len(set(listed)) == len(expected) and set(listed) == set(expected),
            "The maintained metadata summary differs")
    atoms["summary-root"] = members.get(SUMMARY_ROOT)
    return atoms


def move_to_root(node, config, slugs):
    """Give the fresh home the root-row state of an existing home for these slugs.

    One native batch removes each entry from its bucket row and creates the root
    row with them, the state an app before the buckets leaves. The actual app must
    then list, update, and delete these entries through the root row.
    """
    aliases, _, summary = schemas(config)
    name = lambda field: aliases.get(summary, {}).get(field, field)
    queries = [{"schema_name": summary, "fields": [name(field) for field in SUMMARY_FIELDS],
                "filter": {"HashKey": key}, "limit": 2, "offset": 0} for key in SUMMARY_KEYS]
    reply = node.call("/api/queries/batch", {"queries": queries})[0]
    require(reply.get("count") == len(queries) and len(reply.get("results", [])) == len(queries),
            "The summary batch is incomplete")
    rows = {}
    for key, item in zip(SUMMARY_KEYS, reply["results"]):
        require(item.get("status") == 200 and item["response"].get("has_more") is False, "A summary read is incomplete")
        if item["response"]["results"]:
            rows[key] = json.loads(item["response"]["results"][0]["fields"][name("payload_json")])
    require(SUMMARY_ROOT not in rows, "A fresh home of this app already has a root summary row")
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    wanted, moved, mutations = set(slugs), [], []

    def mutation(key, mutation_type, entries):
        return {"type": "mutation", "schema": summary, "mutation_type": mutation_type,
                "key_value": {"hash": key, "range": None},
                "fields_and_values": {name("key"): key, name("updated_at"): now,
                                      name("payload_json"): json.dumps(entries, separators=(",", ":"))}}
    for key, entries in rows.items():
        kept = [entry for entry in entries if entry["slug"] not in wanted]
        if len(kept) != len(entries):
            moved.extend(entry for entry in entries if entry["slug"] in wanted)
            mutations.append(mutation(key, "update", kept))
    require(sorted(entry["slug"] for entry in moved) == sorted(wanted), "A selected summary entry is absent")
    mutations.append(mutation(SUMMARY_ROOT, "create", sorted(moved, key=lambda entry: entry["slug"])))
    written = node.call("/api/mutations/batch", {"mutations": mutations})[0]
    require(written.get("count") == len(mutations), "The root summary setup was not acknowledged")


def require_cloud_off(node, output, phase):
    status = node.call("/api/sync/byte-backup-v2", {"action": "status"})[0]
    require(status.get("enabled") is False and status.get("automatic_backup_enabled") is False
            and status.get("running") is False and status.get("manual_connection") is None,
            "The generated comparison node must keep cloud backup off")
    save(output / f"cloud-off-{phase}.json", {
        key: status.get(key) for key in ("enabled", "automatic_backup_enabled", "running", "manual_connection")})


def finish_setup(node, output, cleanup):
    # Setup reclamation is a one-time cost, outside the steady-state requests.
    flushed = node.call("/api/db/flush", {})[0]
    require(flushed.get("durable") is True, "The app setup lacks a durable flush")
    # A format 7 home has no molecule work; its daemon has no molecule-drain route.
    if not node.record_home():
        until = time.monotonic() + 600
        while True:
            status = node.call("/api/db/molecule-drain", {})[0]["molecule_drain"]
            report = status["report"]
            require(not report["refused"] and not report["last_error"], "App setup reclamation failed")
            if (status["candidate_rows"] == 0 and not status["candidate_rows_capped"]
                    and all(report[key] == 0 for key in ("pending", "parked", "waiting_records"))):
                break
            require(time.monotonic() < until, "App setup reclamation did not finish")
            time.sleep(0.5)
        save(output / "setup-drain.json", status)
    save(output / "setup-cleanup.json", cleanup.request_and_wait(node))


def arm(args, Node, cleanup, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir(mode=0o700)
    candidate = label == "candidate"
    # The main app runs on the compatible daemon. This app runs on the format 7 daemon.
    binary = args.candidate if candidate else args.baseline
    daemon, revision = (args.daemon_after, args.daemon_after_revision) if candidate else (args.daemon_before, args.daemon_before_revision)
    node = Node(daemon, revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
                full_socket_name="folddb-full.sock", environment={"LASTDB_SELF_METRICS_TO_DB":"false",
                    "LASTDB_BYTE_BACKUP_V2_ENABLED":"false", "LASTDB_TTL_SWEEP":"0"})
    config = output / "config.json"
    expected = {slug(index): value(index) for index in range(args.records)}
    removed = [slug(index) for index in range(args.records * 2 - 8, args.records * 2)]
    samples = {operation: [] for operation in OPERATIONS}
    try:
        node.start()
        require_cloud_off(node, output, "before-setup")
        # Each arm sets up its own fresh home. No arm changes an old home.
        command(binary, node, config, "init", "--socket", str(node.socket))
        # Individual CLI calls define the latency workload. Verification batches all known keys.
        for index in range(args.records):
            put(binary, node, config, index)
        original_config = json.loads(config.read_text())
        before = snapshot(node, config, expected)
        save(output / "before-atoms.json", before)
        require_cloud_off(node, output, "after-setup")
        finish_setup(node, output, cleanup)
        node.stop()
        node.start()
        require_cloud_off(node, output, "before-measure")
        # Read known values first; a repeated init must not hide a reopen failure.
        after = snapshot(node, config, expected)
        require(before == after, "Reopen changed a current atom or author metadata")
        save(output / "after-atoms.json", after)
        if candidate:
            command(binary, node, config, "init", "--socket", str(node.socket))
            current = json.loads(config.read_text())
            require(all(current[name] == original_config[name] for name in ("schemaHash", "indexSchemaHash")),
                    "Repeated setup changed a saved definition identity")
            require(snapshot(node, config, expected) == before, "Repeated setup changed a field atom")
            owned = [schema for schema in node.call("/api/schemas")[0]["schemas"] if schema.get("owner_app_id") == "lastsecrets"]
            # A node at API 13 or later (lastdb #803) owns every schema and may omit the key.
            version = node.call("/api/version")[0]
            api_version = (version.get("data") or version).get("api_version", 0)
            owns = lambda schema: schema.get("independent_fields") is True or (
                "independent_fields" not in schema and api_version >= 13)
            require(len(owned) == 2 and all(owns(schema) for schema in owned),
                    "The actual app does not own exactly two schemas")
            require(all(not schema.get("alternate_keys") for schema in owned), "Different record types became alternate keys")
        for index in range(args.records):
            result, elapsed = command(binary, node, config, "get", slug(index), operation="get")
            require(result.stdout.rstrip("\n") == expected[slug(index)], "The actual app returned a different value")
            samples["get"].append(elapsed)
        for index in range(args.records, args.records * 2):
            samples["create"].append(put(binary, node, config, index, operation="create"))
            expected[slug(index)] = value(index)
        if candidate:
            # An existing home keeps its entries in the root row. The timed updates must
            # move the first four to their buckets, and the delete must repair the root row.
            move_to_root(node, config, [slug(index) for index in range(4)] + removed)
        for index in range(args.records):
            samples["update"].append(put(binary, node, config, index, generation=1, operation="update"))
            expected[slug(index)] = value(index, 1)
        for _ in range(args.records):
            for operation, verb, arguments in (("list", "list", ()), ("search", "search", ("ci-example",)),
                                               ("admin_slice", "admin-slice", ())):
                result, elapsed = command(binary, node, config, verb, *arguments, operation=operation)
                samples[operation].append(elapsed)
                if operation == "admin_slice":
                    result = json.loads(result.stdout)
                    require(result["total"] == len(expected) and {item["slug"] for item in result["secrets"]} == set(expected),
                            "The admin metadata membership differs")
                else:
                    listed(result.stdout, set(expected))
        measured = snapshot(node, config, expected)
        if candidate:
            require(measured["summary-root"] == sorted(removed), "An update left its entry in the root row")
        receipt = json.loads(command(binary, node, config, "delete", *removed)[0].stdout)
        require(receipt.get("ok") is True, "The actual batch delete did not complete")
        for key in removed:
            del expected[key]
        listed(command(binary, node, config, "list")[0].stdout, set(expected))
        final = snapshot(node, config, expected, removed)
        if candidate:
            require(final["summary-root"] == [], "The delete left an entry in the root row")
        require_cloud_off(node, output, "after-measure")
        node.stop()
        node.start()
        require_cloud_off(node, output, "after-reopen")
        require(snapshot(node, config, expected, removed) == final, "Reopen changed the final records")
        observations = [json.loads(line) for line in (output / "cli-observations.jsonl").read_text().splitlines()]
        require(len(observations) == args.records * len(OPERATIONS) and all(
            [row["elapsed_ms"] for row in observations if row["operation"] == operation] == samples[operation]
            for operation in OPERATIONS), "The CLI observations do not match every timed sample")
        result = {"label":label,"pair":pair,"samples_ms":samples,"seed_records":args.records,"value_bytes":4096,
                  "remaining":len(expected),"unchanged_seed_atoms":len(before) - 1,"repeat_setup":candidate,
                  "daemon_revision":revision,"fresh_home":True,
                  "reopen":True,"batch_delete":True,"disk":node.disk_breakdown(),
                  "cli_observations": {"count":len(observations),"sha256":hashlib.sha256(
                      (output / "cli-observations.jsonl").read_bytes()).hexdigest()}}
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def render(args, summary):
    lines = ["## LastSecrets fresh-home CLI latency", "",
             f"Main app `{args.baseline_revision}` on the compatible daemon `{args.daemon_before_revision}`.",
             f"This app `{args.candidate_revision}` on the format 7 daemon `{args.daemon_after_revision}`.",
             f"Two balanced AB/BA pairs use {args.records} seed records and 4096 bytes per value, plus equal timed creates.",
             f"Each operation retains {args.records} actual CLI samples per arm.",
             "Each arm creates its own fresh home. No arm changes an old home.",
             "Field values and metadata membership remain equal across reopen. A format 6 home also keeps its atom identities and author metadata.",
             "This app also repeats setup. Before its timed updates, 12 metadata entries move to the root summary row.",
             "Four timed updates must move their entries back to bucket rows. The delete must remove the other eight from the root row.",
             "Timings are advisory.",
             "Times include the CLI process and all app requests. They do not isolate database latency.", "",
             "| Operation | Before P50 ms | After P50 ms | Before P95 ms | After P95 ms | P95 change |", "|---|---:|---:|---:|---:|---:|"]
    for operation in OPERATIONS:
        cells = {}
        for label in ("baseline","candidate"):
            arms = [item for item in summary["arms"] if item["label"] == label]
            require(len(arms) == 2, "Both balanced pairs are required")
            cells[label] = []
            for percentile in (.50,.95):
                values = [sorted(item["samples_ms"][operation]) for item in arms]
                require(all(len(samples) == args.records and all(math.isfinite(item) and item > 0 for item in samples) for samples in values),
                        "A measurement is invalid or incomplete")
                cells[label].append(statistics.median(samples[math.ceil(len(samples) * percentile) - 1] for samples in values))
        old, new = cells["baseline"], cells["candidate"]
        lines.append(f"| {operation} | {old[0]:.3f} | {new[0]:.3f} | {old[1]:.3f} | {new[1]:.3f} | {(new[1]/old[1]-1)*100:+.1f}% |")
    lines.extend(["", "Create and update tails remain separate for each arm:", "",
        "| Arm | Operation | P95 ms | Maximum ms | Calls above 100 ms |", "|---|---|---:|---:|---:|"])
    for arm in summary["arms"]:
        for operation in ("create", "update"):
            samples = sorted(arm["samples_ms"][operation])
            lines.append(f"| {arm['label']} / pair {arm['pair']} | {operation} | "
                f"{samples[math.ceil(len(samples)*.95)-1]:.3f} | {samples[-1]:.3f} | {sum(item>100 for item in samples)} |")
    lines.extend(["", "Each timed CLI call retains child CPU time and bounded daemon/host counter observations.",
        "Counter reads occur before the timer and after its end. They change gaps between calls equally for both sources.",
        "This recipe is a separate experiment from earlier runs without counters. No earlier sample is removed or trimmed.",
        "Host pressure is a shared observation, not proof of a request cause. Missing counters stay unreported."])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "candidate", "daemon-before", "daemon-after", "lastdb-source", "output"):
        parser.add_argument("--" + name, type=Path, required=name == "output")
    for name in ("baseline-revision", "candidate-revision", "daemon-before-revision", "daemon-after-revision"):
        parser.add_argument("--" + name)
    parser.add_argument("--records", type=int, default=64)
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Hosted CI only")
    require(args.records >= 64 and args.records <= 1024, "Use a declared 64 to 1024 record seed")
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(args.output.parent.resolve().is_relative_to(runner), "The output must use this runner's temporary directory")
    if args.audit_only:
        audit_output(args.output, args.records)
        return
    require(all(getattr(args,name) for name in ("baseline", "candidate", "daemon_before", "daemon_after", "lastdb_source",
                "baseline_revision", "candidate_revision", "daemon_before_revision", "daemon_after_revision")), "All exact source and program inputs are required")
    require(all(re.fullmatch(r"[a-f0-9]{40}", getattr(args,name)) for name in
                ("baseline_revision", "candidate_revision", "daemon_before_revision", "daemon_after_revision")), "Exact source revisions are required")
    require(subprocess.check_output(["git", "-C", str(args.lastdb_source), "rev-parse", "HEAD"], text=True).strip()
            == args.daemon_after_revision, "The actual daemon support source differs")
    require(not args.output.exists() and args.output.parent.resolve().is_relative_to(runner), "A fresh runner output path is required")
    args.output.mkdir(mode=0o700)
    sys.path.insert(0, str(args.lastdb_source / "scripts/benchmarks"))
    sys.path.append(str(args.lastdb_source / "scripts/benchmarks/range_continuation"))
    sys.path.append(str(args.lastdb_source / "scripts/disk_v2"))
    from node import Node, file_hash
    import cleanup
    summary = {"complete":False,"sources":{name:str(item) for name,item in vars(args).items()},"arms":[],
               "program_sha256":{name:file_hash(getattr(args,name)) for name in ("baseline","candidate","daemon_before","daemon_after")}}
    try:
        for pair, order in enumerate((("baseline","candidate"),("candidate","baseline"))):
            for label in order:
                summary["arms"].append(arm(args,Node,cleanup,label,pair))
        text = render(args, summary)
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(text)
        summary["complete"] = True
    finally:
        save(args.output / "comparison.json", summary)


if __name__ == "__main__":
    main()
