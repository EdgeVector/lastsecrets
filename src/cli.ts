#!/usr/bin/env bun

import { lastSecretSchema, secretRef } from "./schema.ts";

const [, , command, arg] = process.argv;

if (command === "schema-json") {
  console.log(JSON.stringify(lastSecretSchema, null, 2));
} else if (command === "ref" && arg) {
  console.log(secretRef(arg));
} else {
  console.error("usage: lastsecrets schema-json | lastsecrets ref <slug>");
  process.exit(2);
}
