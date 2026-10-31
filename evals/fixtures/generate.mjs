#!/usr/bin/env node
// Writes the import fixtures next to this script. Byte-exact (encodings, BOMs, line endings),
// so fixtures are generated rather than hand-edited. Expected results: ../golden/import-summaries.json
//
//   node evals/fixtures/generate.mjs           # small fixtures (committed)
//   node evals/fixtures/generate.mjs --large   # also large-50k.csv (git-ignored, ~5 MB)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const write = (name, data) => writeFileSync(join(dir, name), data);
const lines = (rows, eol = '\n') => rows.join(eol) + eol;

// Windows-1252 encoder for the few non-ASCII characters used below.
const CP1252 = { 'é': 0xe9, 'ü': 0xfc, 'ö': 0xf6, 'ñ': 0xf1, '€': 0x80 };
const cp1252 = (s) =>
  Buffer.from([...s].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : CP1252[ch] ?? 0x3f)));

// IMP-F01: mixed formats, one of each reject reason, one in-file duplicate.
write('basic.csv', lines([
  'Mobile No,Name,Segment,Notes',
  '98765 43210,Asha,steel;export,called twice',
  '+91 98450 12345,Ravi,steel,',
  '098765 43210,Asha R,steel,duplicate of row 1',
  '9.19876E+11,Kiran,,',
  ',Meena,,no phone',
  '12345,Joe,,',
  '7012345678,Priya,export,',
  '+44 7911 123456,Tom,export,',
]));

// IMP-F02: semicolon delimiter, Windows-1252, CRLF.
write('semicolon-win1252.csv', cp1252(lines([
  'Téléphone;Nom;Ville',
  '9876543210;José;Pune',
  '9812345678;Müller;Köln',
  '9900112233;Peña;Goa',
], '\r\n')));

// IMP-F03: UTF-8 BOM. First header must be "phone", not "﻿phone".
write('bom-utf8.csv', '﻿' + lines([
  'phone,first_name,email',
  '9876543210,Asha,asha@example.com',
  '9812345678,Ravi,not-an-email',
]));

// IMP-F04: UTF-16 LE with BOM.
write('utf16le.csv', Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(lines(['Mobile,Name', '9876543210,Asha', '9812345678,Ravi'], '\r\n'), 'utf16le'),
]));

// IMP-F05: quoted fields with embedded newlines, quotes and delimiters. 3 data rows.
write('quoted-newlines.csv', lines([
  'phone,name,notes',
  '9876543210,"Rao, Asha","line one',
  'line two"',
  '9812345678,Ravi,"He said ""call later"""',
  '9900112233,Priya,"a,b,c',
  '',
  'end"',
]));

// IMP-F06: tab-delimited .txt.
write('tab-delimited.txt', lines(['WhatsApp\tFirst Name\tCity', '9876543210\tAsha\tPune', '9812345678\tRavi\tMumbai']));

// IMP-F07: opt-in column with mixed truthy/falsy values.
write('opt-in-column.csv', lines([
  'phone,name,consent',
  '9876543210,A,yes',
  '9812345678,B,true',
  '9900112233,C,1',
  '9123456780,D,y',
  '9845012345,E,Y',
  '7012345678,F,TRUE',
  '8123456789,G,no',
  '6000000000,H,',
]));

// EM-03/EM-36: email column + separate email opt-in column (SPEC §4.6, D12).
write('email-opt-in.csv', lines([
  'Mobile No,Name,Email,Email Consent,Segment',
  '9876543210,Asha, Asha@Example.COM ,yes,steel',
  '9812345678,Ravi,ravi@example.in,yes,steel',
  '9900112233,Kiran,not-an-email,yes,export',
  '9123456780,Meena,info@example.com,no,steel',
  '9845012345,Priya,asha@example.com,yes,export',
  '7012345678,Tom,,,steel',
]));

// IMP-F08: formula-injection payloads in text fields (export round-trip).
write('injection.csv', lines([
  'phone,name,company',
  '9876543210,=SUM(1+1),@evil',
  '9812345678,-2+3,"+cmd|\' /C calc\'!A0"',
  '9900112233,Normal,Acme',
]));

// IMP-F09: same phones as basic.csv, extra fields, for existing-contact policies.
write('update-existing.csv', lines([
  'Mobile No,Name,Company,Segment',
  '9876543210,Asha Kumar,Acme Steel,retail',
  '9845012345,,Ravi Traders,',
]));

// IMP-F10: 201 columns (limit is 200).
write('too-many-columns.csv', lines([
  ['phone', ...Array.from({ length: 200 }, (_, i) => `c${i + 1}`)].join(','),
  ['9876543210', ...Array.from({ length: 200 }, () => 'x')].join(','),
]));

// IMP-F11: header-less file; row 1 is data.
write('no-header.csv', lines(['9876543210,Asha', '9812345678,Ravi']));

// IMP-F12: preamble rows before the header (rows-to-skip = 2).
write('preamble.csv', lines(['Exported from CRM', 'Generated 2026-10-01', 'phone,name', '9876543210,Asha']));

if (process.argv.includes('--large')) {
  // IMP-F13: 50,000 unique, valid Indian mobiles, 10 columns. Deterministic.
  const prefixes = ['98', '97', '96', '95', '94', '93', '91', '90', '89', '88', '87', '86', '85', '84', '83',
    '82', '81', '80', '79', '78', '77', '76', '75', '74', '73', '72', '70', '63', '62'];
  const cities = ['Mumbai', 'Pune', 'Delhi', 'Chennai', 'Kolkata', 'Bengaluru', 'Hyderabad', 'Ahmedabad'];
  const rows = ['phone,first_name,last_name,email,company,city,tags,opt_in,source,joined'];
  const seen = new Set();
  for (let i = 0; i < 50000; i++) {
    const phone = prefixes[i % prefixes.length] + String(10000000 + ((i * 7919) % 90000000)).padStart(8, '0');
    seen.add(phone);
    rows.push([phone, `First${i}`, `Last${i}`, `user${i}@example.com`, `Company ${i % 500}`,
      cities[i % cities.length], i % 3 ? 'steel' : 'steel;export', 'yes', 'expo-2026',
      `2026-${String((i % 12) + 1).padStart(2, '0')}-15`].join(','));
  }
  if (seen.size !== 50000) throw new Error(`expected 50000 unique phones, got ${seen.size}`);
  write('large-50k.csv', lines(rows));
}

console.log('fixtures written to', dir);
