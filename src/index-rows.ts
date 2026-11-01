/**
 * Row layout of the LastSecretIndex metadata list.
 *
 * A format 7 home stores one record per key and refuses a record whose encoded
 * value (every field plus one stamp per field) is above 64 KiB
 * (`lastdb_model::record_value::MAX_RECORD_BYTES`). One `__all__` row for every
 * secret reaches that cap at a few hundred secrets, so the list is split over a
 * fixed set of rows of the same schema, key and field:
 *
 * - `__all__`, the root row. Every existing home already has it, and an app
 *   before this layout kept every entry there. That state stays valid as is.
 * - INDEX_BUCKET_COUNT bucket rows. A put writes the entry of a slug to the
 *   bucket chosen from sha256(slug), and removes the entry from the root row
 *   if the root row holds it. New entries never enter the root row, so the
 *   root row only shrinks.
 *
 * A reader takes the union of every row in INDEX_ROW_KEYS order; a later row
 * wins for a slug, so a bucket entry wins over a root entry. That covers the
 * one transient duplicate a put can leave (bucket written, root removal lost).
 *
 * File-blob spill does not fit here: payload_json is a String field, and the
 * node keeps a local blob only while a field of type Any holds its pointer as
 * the whole value. A pointer inside a JSON string is no reference, and the
 * dwell pass deletes that blob after LASTDB_BLOB_DWELL_SECS (one hour).
 */
import { createHash } from "node:crypto";

import { ALL_SECRETS_INDEX_KEY } from "./schema.ts";

/** Fixed for the life of the layout: the bucket of a slug derives from it. 256 % 32 == 0, so a byte maps evenly. */
export const INDEX_BUCKET_COUNT = 32;

export const INDEX_BUCKET_KEYS: readonly string[] = Array.from(
  { length: INDEX_BUCKET_COUNT },
  (_, bucket) => `__bucket_${String(bucket).padStart(2, "0")}__`,
);

/** Every index row in read order. 33 keys fit one native 64-query batch. */
export const INDEX_ROW_KEYS: readonly string[] = [ALL_SECRETS_INDEX_KEY, ...INDEX_BUCKET_KEYS];

/**
 * Largest payload_json a put writes into one bucket row, measured as the value
 * sits inside the stored record: a JSON string, escapes included. The other
 * two fields and the three stamps take about 1 KiB of the 64 KiB record cap.
 * At about 370 stored bytes per entry a bucket holds about 130 entries, so the
 * 32 buckets hold about 4,000 secrets at an even spread.
 */
export const INDEX_ROW_MAX_BYTES = 48 * 1024;

export function indexBucketKey(slug: string): string {
  const first = createHash("sha256").update(slug, "utf8").digest()[0]!;
  return INDEX_BUCKET_KEYS[first % INDEX_BUCKET_COUNT]!;
}

/** UTF-8 size of a payload_json value as the record stores it (JSON-escaped string). */
export function storedPayloadBytes(payload: string): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}
