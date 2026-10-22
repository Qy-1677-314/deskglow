const path = require('path');
const fs = require('fs');
const ps = require('../src/main/ps');

(async () => {
  const desktop = 'C:\\Users\\N3sL4y\\Desktop';
  const paths = [
    'C:\\Users\\Public\\Desktop\\微信.lnk',
    path.join(desktop, '26.10.17作业.docx'),
    desktop,
    path.join(desktop, 'Text 1.pdf'),
    path.join(desktop, 'Clash.lnk'),
    path.join(desktop, 'Visual Studio Code.lnk'),
  ];
  const inp = path.join(process.env.TEMP, 'dg-icons-in.json');
  const out = path.join(process.env.TEMP, 'dg-icons-out.json');
  const jobs = paths.map((p, i) => ({ id: 'j' + i, key: p, file: p, index: 0, alts: [], shell: p }));
  fs.writeFileSync(inp, JSON.stringify(jobs), 'utf8');
  const r = await ps.runScript('icon-extract.ps1', ['-Payload', inp, '-Out', out, '-Size', '128'], { timeout: 90000 });
  console.log('run ok:', r.ok, r.ok ? '' : r.error.slice(0, 300));
  const data = ps.readJsonFile(out) || {};
  for (const j of jobs) {
    const v = data[j.id];
    console.log(j.file, '=>', v ? Math.round(v.length / 1024) + ' KB' : 'NULL');
    if (v) fs.writeFileSync(path.join(__dirname, '..', 'shots', 'icon-' + j.id + '.png'), Buffer.from(v, 'base64'));
  }
})();
