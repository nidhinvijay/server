const fs = require("fs");
const path = require("path");
const vm = require("vm");

const envPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), ".env");

const content = fs.readFileSync(envPath, "utf8");
const key = "INSTRUMENTS_DATA=";
const keyIndex = content.indexOf(key);

if (keyIndex === -1) {
  throw new Error(`Missing ${key} in ${envPath}`);
}

const valueStart = keyIndex + key.length;
const valueEnd = content.indexOf("];", valueStart);

if (valueEnd === -1) {
  throw new Error("Could not find closing '];' for INSTRUMENTS_DATA");
}

const rawValue = content.slice(valueStart, valueEnd + 2);
const cleaned = rawValue.trim().replace(/;$/, "");
const data = vm.runInNewContext(`(${cleaned})`, Object.create(null));
const json = JSON.stringify(data);

const updated =
  content.slice(0, valueStart) + json + content.slice(valueEnd + 2);

fs.writeFileSync(envPath, updated, "utf8");
console.log(`Rewrote INSTRUMENTS_DATA as JSON in ${envPath}`);
