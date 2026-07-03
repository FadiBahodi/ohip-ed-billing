// dist/oracle_web.js — REAL browser oracle for the SHIPPED (PII-free) dist build.
// Drives dist/index.html in a headless Chrome and asserts the answer renders.
// Prints exactly one line: ORACLE_RESULT { ... }
//
// Local (server already up on :8795):
//   node dist/oracle_web.js
//   BILLING_URL=http://127.0.0.1:8795/index.html node dist/oracle_web.js
// Live (GitHub Pages):
//   BILLING_URL=https://fadibahodi.github.io/ohip-ed-billing/index.html node dist/oracle_web.js
//
// Uses ortho's puppeteer-core (READ-ONLY require only) + the installed Chrome.

const PUPPETEER = "/Users/rawproductivity/Desktop/Projects_Code/ortho/node_modules/puppeteer-core";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.BILLING_URL || "http://127.0.0.1:8795/index.html";

const puppeteer = require(PUPPETEER);

// wait until an element's innerText matches a regex (serialized across the bridge)
async function waitText(page, sel, re, timeout = 9000) {
  await page.waitForFunction(
    (s, src, flags) => {
      const el = document.querySelector(s);
      return !!el && new RegExp(src, flags).test(el.innerText);
    },
    { timeout }, sel, re.source, re.flags
  );
}

// real DOM click on the first matching element (robust vs the sticky hero overlay)
async function clickSel(page, sel, timeout = 9000) {
  await page.waitForSelector(sel, { timeout });
  await page.$eval(sel, (el) => el.click());
}

async function textOf(page, sel) {
  return page.$eval(sel, (el) => el.innerText);
}

(async () => {
  const errors = [];
  const res = { passed: false, chips_ok: false, freetext_ok: false, copy_ok: false, export_ok: false, reduction_ok: false, percent_ok: false, url: URL, errors };
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 2200, deviceScaleFactor: 1 });

    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text());
    });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("requestfailed", (r) => {
      const u = r.url();
      if (!/favicon/i.test(u)) errors.push("requestfailed: " + u + " " + (r.failure() && r.failure().errorText));
    });

    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    // app booted once the chips exist
    await page.waitForSelector('#time-chips [data-id="day"]', { timeout: 15000 });
    await page.waitForSelector('#complexity-chips [data-id="comprehensive"]', { timeout: 15000 });

    // (a) chips: Weekday-day + Comprehensive -> H102 $43.05
    await clickSel(page, '#time-chips [data-id="day"]');
    await clickSel(page, '#complexity-chips [data-id="comprehensive"]');
    await waitText(page, "#output", /H102/);
    const aText = await textOf(page, "#output");
    res.chips_ok = /\bH102\b/.test(aText) && /\$43\.05/.test(aText);

    // (b) free text: night intubation -> a night H-code + G211
    const vignette = "0230 chest pain, full workup, patient intubated for airway protection, then admitted";
    await page.click("#case-text");
    await page.type("#case-text", vignette, { delay: 0 });
    await clickSel(page, "#parse-btn");
    await waitText(page, "#output", /G211/);
    const bText = await textOf(page, "#output");
    res.freetext_ok = /\bH12\d\b/.test(bText) && /\bG211\b/.test(bText);

    // (c) a one-tap copy claim line + an export control exist
    res.copy_ok = (await page.$("#copy-claim")) !== null;
    const exportBtns = await page.$$("#export [data-export]");
    res.export_ok = exportBtns.length >= 2;

    // helper: type a query into the procedure search (clearing any prior text first), then tap the code chip
    async function pickProc(code) {
      await page.focus("#proc-search");
      // hard-clear the field and fire the input event so the chip list re-renders from empty
      await page.$eval("#proc-search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.type("#proc-search", code, { delay: 10 });          // filters the chips down to this code
      await clickSel(page, `#procedure-chips [data-id="${code}"]`);  // tap the matching code chip
    }

    // (A) ONE REDUCTION PER SITE: ankle fracture (F075) + ankle dislocation (D035).
    // Must show the "one reduction per site" warning and must NOT bill both (D035 excluded).
    await pickProc("F075");
    await pickProc("D035");
    await waitText(page, "#hero-warnings", /reduction per site/i);
    const warnText = await textOf(page, "#hero-warnings");
    const lineText = await textOf(page, "#line-items");
    res.reduction_ok =
      /one reduction per site/i.test(warnText) &&   // the warning is surfaced
      /\bF075\b/.test(lineText) &&                  // first reduction kept as a billed line
      !/\bD035\b/.test(lineText);                   // duplicate NOT summed into the line items

    // (B) PERCENT PREMIUM: E420 renders as a "+50%" premium line, not a flat $50.
    await pickProc("E420");
    await waitText(page, "#output", /E420/);
    const eText = await textOf(page, "#output");
    res.percent_ok =
      /\bE420\b/.test(eText) &&                     // the code is present
      /\+50%/.test(eText) &&                        // shown as a +50% premium
      !/E420[^\n]*\$50\.00/.test(eText);            // NOT a flat $50.00 line

    res.passed = res.chips_ok && res.freetext_ok && res.copy_ok && res.export_ok &&
      res.reduction_ok && res.percent_ok && errors.length === 0;
  } catch (e) {
    errors.push("exception: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  }
  console.log("ORACLE_RESULT " + JSON.stringify(res));
  process.exit(res.passed ? 0 : 1);
})();
