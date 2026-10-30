#!/usr/bin/env python3
"""Hosted-CI latency for the actual CLI across conversion and a daemon upgrade."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time

OPERATIONS = ("get", "create", "update", "list", "search", "admin_slice")
SECRET_FIELDS = ("slug", "label", "provider", "purpose", "environment", "secret_value", "created_at", "updated_at")
SUMMARY_FIELDS = ("key", "payload_json", "updated_at")


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


def command(binary, node, config, verb, *arguments, payload=None, allow_failure=False):
    started = time.perf_counter_ns()
    result = subprocess.run([str(binary), verb, *arguments, "--config", str(config)],
                            input=payload, text=True, capture_output=True,
                            env=cli_environment(node, config), timeout=120)
    elapsed = (time.perf_counter_ns() - started) / 1e6
    # CLI output can contain a generated value. Never copy it into an error or log.
    if result.returncode and verb in ("init", "schema-values-convert"):
        # These control commands never fetch value bytes. The output audit
        # still checks this file before any artifact upload.
        (config.parent / f"failed-{verb}.stderr").write_text(result.stderr)
    require(result.returncode == 0 or allow_failure, f"Actual CLI {verb} failed; no value is retained in this error")
    return result, elapsed


def put(binary, node, config, index, generation=0):
    return command(binary, node, config, "put", slug(index), "--label", slug(index),
                   "--provider", "ci-example", "--purpose", "generated CI record", "--env", "ci",
                   "--value-stdin", payload=value(index, generation))[1]


def listed(text, expected):
    lines = [line for line in text.splitlines() if line]
    require(len(lines) == len(expected) and {line.split("\t")[0] for line in lines} == expected,
            "The complete metadata membership differs")
    require(all("value=<redacted>" in line for line in lines), "A metadata result lacks its redaction marker")


def snapshot(node, config, expected, absent=()):
    cfg = json.loads(config.read_text())
    aliases = cfg.get("schemaFieldAliases", {})
    record_schema = cfg["schemaHash"] if cfg["schemaHash"] in aliases else cfg.get("schemaName", cfg["schemaHash"])
    summary = cfg["indexSchemaHash"] if cfg["indexSchemaHash"] in aliases else cfg.get("indexSchemaName", cfg["indexSchemaHash"])
    requests = [(record_schema, key, SECRET_FIELDS) for key in expected] + [(summary, "__all__", SUMMARY_FIELDS)]
    requests.extend((record_schema, key, SECRET_FIELDS) for key in absent)
    queries = [{"schema_name": schema, "fields": [aliases.get(schema, {}).get(field, field) for field in fields],
                "filter": {"HashKey": key}, "limit": 2, "offset": 0, "response_format":"full"} for schema, key, fields in requests]
    atoms = {}
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
            if key in absent and query["schema_name"] == record_schema:
                require(result == [], "A deleted key still returns a record")
                continue
            require(len(result) == 1, "A known record is absent or ambiguous")
            row = result[0]
            require(row.get("key") == {"hash": key, "range": None}, "An exact read returned another key")
            fields, metadata = row.get("fields", {}), row.get("metadata", {})
            require(set(fields) == set(query["fields"]), "A known record lacks declared fields")
            if query["schema_name"] == record_schema:
                name = aliases.get(record_schema, {}).get("secret_value", "secret_value")
                require(fields[name] == {"value": expected[key]}, "A complete generated value differs")
            else:
                name = aliases.get(summary, {}).get("payload_json", "payload_json")
                members = json.loads(fields[name])
                require(len(members) == len(expected) and {item["slug"] for item in members} == set(expected),
                        "The maintained metadata summary differs")
            for field in query["fields"]:
                info = metadata.get(field, {})
                require(isinstance(info.get("atom_uuid"), str) and info["atom_uuid"], "A field lacks its current atom identity")
                # Molecules change at conversion. Current atoms and author metadata must not.
                atoms[f"{query['schema_name']}/{key}/{field}"] = {name: info.get(name)
                    for name in ("atom_uuid", "writer_pubkey", "metadata")}
    return atoms


def arm(args, Node, finish_setup, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir(mode=0o700)
    fresh = label == "fresh"
    binary = args.candidate if label != "baseline" else args.baseline
    daemon, revision = (args.daemon_after, args.daemon_after_revision) if fresh else (args.daemon_before, args.daemon_before_revision)
    node = Node(daemon, revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
                full_socket_name="folddb-full.sock", environment={"LASTDB_SELF_METRICS_TO_DB":"false",
                    "LASTDB_BYTE_BACKUP_V2_ENABLED":"false", "LASTDB_TTL_SWEEP":"0"})
    config = output / "config.json"
    expected = {slug(index): value(index) for index in range(args.records)}
    samples = {operation: [] for operation in OPERATIONS}
    try:
        node.start()
        setup = args.candidate if fresh else args.baseline
        command(setup, node, config, "init", "--socket", str(node.socket))
        # Individual CLI calls define the latency workload. Verification batches all known keys.
        for index in range(args.records):
            put(setup, node, config, index)
        original_config = json.loads(config.read_text())
        before = snapshot(node, config, expected)
        save(output / "before-atoms.json", before)
        if label == "candidate":
            plan = json.loads(command(binary, node, config, "schema-values-convert")[0].stdout)
            require(plan.get("phase") == "plan" and len(plan.get("schemas", [])) == 2, "The normal app did not return its conversion plan")
            try:
                converted = command(binary, node, config, "schema-values-convert", "--apply", "--maintenance")[0]
            except RuntimeError:
                # Diagnose only this generated home. Never retry an active job,
                # and never turn the original CLI failure into a passing arm.
                try:
                    current = node.call("/api/db/alternate-keys", {"action":"app_status"})[0]
                    save(output / "conversion-status.json", current)
                except RuntimeError as status_error:
                    (output / "conversion-status-rejection.txt").write_text(str(status_error))
                    absent = "/api/db/alternate-keys: HTTP 404: b'app conversion is absent'"
                    if str(status_error) == absent:
                        try:
                            node.call("/api/db/alternate-keys", {"action":"app_begin", "schemas":plan["schemas"],
                                      "retire":plan["retire"], "maintenance":True})
                        except RuntimeError as rejection:
                            # Owner control metadata only. The generated-value
                            # audit must pass before this file can be uploaded.
                            (output / "conversion-rejection.txt").write_text(str(rejection))
                        else:
                            save(output / "conversion-reproduction.json", {"direct_begin_succeeded":True})
                raise
            report = json.loads(converted.stdout)
            require(report.get("phase") == "complete" and report.get("durable") is True and
                    report.get("selected_keys") == report.get("expected_selected_keys") == args.records + 1,
                    "The actual app conversion is incomplete")
            save(output / "conversion.json", report)
        finish_setup(node, output)
        node.stop()
        if label == "candidate":
            node.binary, node.revision = args.daemon_after, args.daemon_after_revision
        node.start()
        # Read known values first; a repeated init must not hide an upgrade failure.
        after = snapshot(node, config, expected)
        require(before == after, "Conversion or reopen changed a current atom or author metadata")
        save(output / "after-atoms.json", after)
        if label != "baseline":
            command(binary, node, config, "init", "--socket", str(node.socket))
            current = json.loads(config.read_text())
            require(all(current[name] == original_config[name] for name in ("schemaHash", "indexSchemaHash")),
                    "Repeated setup changed a saved definition identity")
            require(snapshot(node, config, expected) == before, "Repeated setup changed a field atom")
            owned = [schema for schema in node.call("/api/schemas")[0]["schemas"] if schema.get("owner_app_id") == "lastsecrets"]
            require(len(owned) == 2 and all(schema.get("independent_fields") is True for schema in owned),
                    "The actual app does not own exactly two schemas")
            require(all(not schema.get("alternate_keys") for schema in owned), "Different record types became alternate keys")
        for index in range(args.records):
            result, elapsed = command(binary, node, config, "get", slug(index))
            require(result.stdout.rstrip("\n") == expected[slug(index)], "The actual app returned a different value")
            samples["get"].append(elapsed)
        for index in range(args.records, args.records * 2):
            samples["create"].append(put(binary, node, config, index))
            expected[slug(index)] = value(index)
        for index in range(args.records):
            samples["update"].append(put(binary, node, config, index, generation=1))
            expected[slug(index)] = value(index, 1)
        for _ in range(16):
            for operation, verb, arguments in (("list", "list", ()), ("search", "search", ("ci-example",)),
                                               ("admin_slice", "admin-slice", ())):
                result, elapsed = command(binary, node, config, verb, *arguments)
                samples[operation].append(elapsed)
                if operation == "admin_slice":
                    result = json.loads(result.stdout)
                    require(result["total"] == len(expected) and {item["slug"] for item in result["secrets"]} == set(expected),
                            "The admin metadata membership differs")
                else:
                    listed(result.stdout, set(expected))
        snapshot(node, config, expected)
        removed = [slug(index) for index in range(args.records * 2 - 8, args.records * 2)]
        receipt = json.loads(command(binary, node, config, "delete", *removed)[0].stdout)
        require(receipt.get("ok") is True, "The actual batch delete did not complete")
        for key in removed:
            del expected[key]
        listed(command(binary, node, config, "list")[0].stdout, set(expected))
        final = snapshot(node, config, expected, removed)
        node.stop()
        node.start()
        require(snapshot(node, config, expected, removed) == final, "Reopen changed the final records")
        result = {"label":label,"samples_ms":samples,"seed_records":args.records,"value_bytes":4096,
                  "remaining":len(expected),"unchanged_seed_atoms":len(before),"repeat_setup":label != "baseline",
                  "reopen":True,"batch_delete":True,"disk":node.disk_breakdown()}
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def render(args, summary):
    lines = ["## LastSecrets conversion and CLI latency", "",
             f"App: `{args.baseline_revision}` → `{args.candidate_revision}`.",
             f"Compatible daemon: `{args.daemon_before_revision}`. Removal daemon: `{args.daemon_after_revision}`.",
             f"Two balanced AB/BA pairs use {args.records} seed records and 4096 bytes per value, plus equal timed creates.",
             "The candidate converts on the compatible daemon, then reopens the same home on the removal daemon.",
             "A separate fresh-init arm uses the removal daemon. Current atom identities and author metadata remain equal across conversion and reopen.",
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
                require(all(len(samples) >= 16 and all(math.isfinite(item) and item > 0 for item in samples) for samples in values),
                        "A measurement is invalid or incomplete")
                cells[label].append(statistics.median(samples[math.ceil(len(samples) * percentile) - 1] for samples in values))
        old, new = cells["baseline"], cells["candidate"]
        lines.append(f"| {operation} | {old[0]:.3f} | {new[0]:.3f} | {old[1]:.3f} | {new[1]:.3f} | {(new[1]/old[1]-1)*100:+.1f}% |")
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
    from node import Node, file_hash
    from app_multi_key_compare import finish_setup
    summary = {"complete":False,"sources":{name:str(item) for name,item in vars(args).items()},"arms":[],
               "program_sha256":{name:file_hash(getattr(args,name)) for name in ("baseline","candidate","daemon_before","daemon_after")}}
    try:
        for pair, order in enumerate((("baseline","candidate"),("candidate","baseline"),("fresh",))):
            for label in order:
                summary["arms"].append(arm(args,Node,finish_setup,label,pair))
        text = render(args, summary)
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(text)
        summary["complete"] = True
    finally:
        save(args.output / "comparison.json", summary)


if __name__ == "__main__":
    main()
