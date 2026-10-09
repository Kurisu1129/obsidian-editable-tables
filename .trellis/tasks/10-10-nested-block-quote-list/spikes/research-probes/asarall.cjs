const fs = require('fs');
const p = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] || 800);
const after = Number(process.argv[5] || 800);
const buf = fs.readFileSync(p, 'utf8');
let i = -1, n = 0;
while ((i = buf.indexOf(needle, i + 1)) >= 0 && n < 12) {
  n++;
  console.log(`\n===== occurrence ${n} @ ${i} =====`);
  console.log(buf.slice(Math.max(0, i - before), i + needle.length + after));
}
if (n === 0) console.log('NOT FOUND: ' + needle);
