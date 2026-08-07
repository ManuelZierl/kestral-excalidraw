import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const schemaPath = process.argv[2];
if (!schemaPath) {
  throw new Error("usage: npm run test:package-schema -- <path-to-versioned-app.schema.json>");
}

const [schema, manifest] = await Promise.all([
  readFile(schemaPath, "utf8").then(JSON.parse),
  readFile(new URL("../dist/app.json", import.meta.url), "utf8").then(JSON.parse),
]);
const validate = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
  formats: {
    uri: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
  },
}).compile(schema);
if (!validate(manifest)) {
  throw new Error(`dist/app.json does not match the pinned Kestral package schema: ${JSON.stringify(validate.errors)}`);
}
console.log("dist/app.json matches the pinned Kestral package schema");
