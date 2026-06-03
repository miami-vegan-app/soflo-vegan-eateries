import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }).then(c=>c.newPage());
const errs=[]; pg.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
pg.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
await pg.goto('http://localhost:4178/', { waitUntil: 'networkidle' });
// dismiss setup screen if shown
await pg.evaluate(()=>{ try{ localStorage.setItem('sofloveg_setup_done','1'); }catch(e){} });
await pg.reload({ waitUntil:'networkidle' });
await pg.waitForTimeout(400);
await pg.screenshot({ path: process.env.TEMP + '\soflo-collapsed.png' });
// expand filters
await pg.click('#filters-toggle');
await pg.waitForTimeout(200);
await pg.screenshot({ path: process.env.TEMP + '\soflo-expanded.png' });
console.log('ERRORS:', JSON.stringify(errs));
await b.close();
